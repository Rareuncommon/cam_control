#!/usr/bin/env python3
"""Turn a Claude Code session transcript into something another tool can read.

Written to hand this project's history to a different assistant, but there is
nothing CamBridge-specific in here: point it at any session JSONL.

Three things it is careful about.

**It does not pretend a summary is a conversation.** A session that has been
compacted keeps its earlier half only as a summary blob, and a transcript that
silently splices that in alongside real turns misrepresents what is recoverable.
The summary is emitted under its own heading saying exactly that.

**It redacts by default.** Exporting means handing the text to someone else, so
the default is the safe one and `--no-redact` is the deliberate choice.

**It keeps the raw JSONL parseable.** Redaction is applied to string values
inside each record and the record is re-serialised, rather than run over the
file as text, so the result still loads line by line. A sed pass would be
simpler and would corrupt any line where a replacement changed an escape.
"""

import argparse
import base64
import json
import pathlib
import re
import sys

# Substitutions applied to every string. Ordered: the longest, most specific
# patterns first, so a home path is not half-replaced by a username rule.
REDACTIONS = [
    (re.compile(r'/Users/[A-Za-z0-9._-]+'), '/Users/OPERATOR'),
    (re.compile(r'\b[\w.+-]+@(?!anthropic\.com)[\w-]+\.[\w.]+\b'), 'REDACTED@EXAMPLE.COM'),
    # The studio's production VLAN. Matched on the /24 prefix rather than on
    # prefix-plus-octet: the docs also write it as "172.16.16.x", and a pattern
    # demanding a numeric final octet left the subnet itself in the output.
    # Only the last octet is kept, so one camera can still be told from another.
    #
    # 192.0.2.0/24 is the RFC 5737 documentation range, so the replacement
    # cannot be mistaken for somewhere real.
    (re.compile(r'\b172\.16\.16\.'), '192.0.2.'),
]

# Entry types that are plumbing rather than conversation.
SKIP_TYPES = {'attachment', 'atis-latch', 'mode', 'queue-operation', 'last-prompt'}


def redact(text, enabled=True):
    if not enabled or not isinstance(text, str):
        return text
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def redact_deep(obj, enabled=True):
    """Redact strings in place through a nested structure."""
    if not enabled:
        return obj
    if isinstance(obj, str):
        return redact(obj, True)
    if isinstance(obj, list):
        return [redact_deep(v, True) for v in obj]
    if isinstance(obj, dict):
        return {k: redact_deep(v, True) for k, v in obj.items()}
    return obj


def load(path):
    """Yield parsed records, skipping anything unparseable rather than dying."""
    with open(path, encoding='utf-8', errors='replace') as fh:
        for number, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield number, json.loads(line)
            except json.JSONDecodeError:
                print(f'  warning: line {number} is not JSON, skipped', file=sys.stderr)


def blocks_of(record):
    """Normalise a record's content into a list of blocks."""
    message = record.get('message')
    if not isinstance(message, dict):
        return None, []
    content = message.get('content')
    if isinstance(content, str):
        content = [{'type': 'text', 'text': content}]
    if not isinstance(content, list):
        return message.get('role'), []
    return message.get('role'), [b for b in content if isinstance(b, dict)]


def fence(text, language=''):
    """Fence a block, widening the fence if the text contains one itself."""
    ticks = '```'
    while ticks in text:
        ticks += '`'
    return f'{ticks}{language}\n{text}\n{ticks}'


def write_transcript(records, out_path, images_dir, cap, do_images, do_redact):
    lines = []
    image_count = 0
    summary_done = False

    lines.append('# CamBridge — Claude Code session transcript\n')
    lines.append(
        'Exported from a Claude Code session. Assistant reasoning blocks and '
        'editor plumbing are omitted; everything else is verbatim.\n')

    for _, record in records:
        if record.get('type') in SKIP_TYPES:
            continue
        role, blocks = blocks_of(record)
        if role not in ('user', 'assistant'):
            continue

        for block in blocks:
            kind = block.get('type')

            if kind == 'text':
                text = redact(block.get('text') or '', do_redact).strip()
                if not text:
                    continue
                # The compaction summary is the first user text and is not a
                # turn. Say so rather than letting it read as something typed.
                if (role == 'user' and not summary_done
                        and text.startswith('This session is being continued')):
                    summary_done = True
                    lines.append('\n---\n')
                    lines.append('## Summary of the earlier, compacted half\n')
                    lines.append(
                        '> Everything before this point exists **only** as the '
                        'summary below — the verbatim turns were discarded when '
                        'the session was compacted, and cannot be recovered.\n')
                    # The summary carries its own ## headings. Left alone they
                    # sit at the same level as this document's, so an outline
                    # of the export reads as though the summary's sections were
                    # top-level parts of the conversation.
                    demoted = re.sub(r'^(#{1,5}) ', r'#\1 ', text, flags=re.M)
                    lines.append(demoted + '\n')
                    lines.append('\n---\n')
                    lines.append('## Verbatim conversation from here on\n')
                    continue
                lines.append(f'\n### {"Operator" if role == "user" else "Claude"}\n')
                lines.append(text + '\n')

            elif kind == 'tool_use':
                name = block.get('name', '?')
                params = block.get('input') or {}
                # Bash is most of this session and its command is the
                # interesting part; everything else gets its arguments as JSON.
                if name == 'Bash' and 'command' in params:
                    body = redact(str(params['command']), do_redact)
                    lines.append(f'\n**`{name}`**\n')
                    lines.append(fence(body, 'sh') + '\n')
                else:
                    body = redact(json.dumps(params, indent=2)[:cap], do_redact)
                    lines.append(f'\n**`{name}`**\n')
                    lines.append(fence(body, 'json') + '\n')

            elif kind == 'tool_result':
                content = block.get('content')
                text = ''
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for sub in content:
                        if not isinstance(sub, dict):
                            continue
                        # Most images in a session arrive this way — a Read of a
                        # screenshot — not as a pasted attachment. Flattening
                        # them to "[image]" would drop the visual record of
                        # every panel check, which is most of the evidence that
                        # the UI work was verified at all.
                        if sub.get('type') == 'image':
                            if not do_images:
                                parts.append('[image]')
                                continue
                            data = (sub.get('source') or {}).get('data')
                            if not data:
                                parts.append('[image]')
                                continue
                            image_count += 1
                            name = f'image-{image_count:03d}.png'
                            try:
                                (images_dir / name).write_bytes(base64.b64decode(data))
                                parts.append(f'![screenshot]({images_dir.name}/{name})')
                            except Exception as err:           # noqa: BLE001
                                parts.append(f'[image could not be decoded: {err}]')
                        else:
                            parts.append(sub.get('text') or '')
                    text = '\n'.join(parts)
                text = redact(text, do_redact).strip()
                if not text:
                    continue
                # An image link has to sit outside the fence to render, so a
                # result carrying one is emitted as plain markdown rather than
                # as a code block.
                if '![screenshot](' in text:
                    lines.append('\n' + text + '\n')
                    continue
                truncated = len(text) > cap
                shown = text[:cap] + (f'\n… [{len(text) - cap} more characters]'
                                      if truncated else '')
                lines.append('<details><summary>result</summary>\n')
                lines.append(fence(shown) + '\n')
                lines.append('</details>\n')

            elif kind == 'image' and do_images:
                source = block.get('source') or {}
                data = source.get('data')
                if not data:
                    continue
                image_count += 1
                name = f'image-{image_count:03d}.png'
                try:
                    (images_dir / name).write_bytes(base64.b64decode(data))
                    lines.append(f'\n![screenshot]({images_dir.name}/{name})\n')
                except Exception as err:                       # noqa: BLE001
                    lines.append(f'\n*[image {image_count} could not be decoded: {err}]*\n')

    out_path.write_text('\n'.join(lines), encoding='utf-8')
    return image_count


def write_raw(records, out_path, do_redact):
    """Re-serialise each record, redacted, one per line."""
    with open(out_path, 'w', encoding='utf-8') as fh:
        for _, record in records:
            fh.write(json.dumps(redact_deep(record, do_redact), ensure_ascii=False) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('transcript')
    ap.add_argument('outdir')
    ap.add_argument('--cap', type=int, default=4000,
                    help='max characters of tool output to keep (default 4000)')
    ap.add_argument('--no-redact', action='store_true')
    ap.add_argument('--redact-extra', action='append', default=[], metavar='TEXT',
                    help='additional literal string to redact; repeatable. Use for '
                         'names the patterns cannot know about — a handle, a client, '
                         'a venue. Note that a transcript discussing redaction will '
                         'contain the search strings themselves.')
    ap.add_argument('--no-images', action='store_true')
    ap.add_argument('--only', choices=['transcript', 'raw'])
    args = ap.parse_args()

    do_redact = not args.no_redact
    for extra in args.redact_extra:
        if extra:
            REDACTIONS.append((re.compile(re.escape(extra), re.I), 'REDACTED'))
    outdir = pathlib.Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    images_dir = outdir / 'images'
    if not args.no_images:
        images_dir.mkdir(exist_ok=True)

    records = list(load(args.transcript))
    print(f'  read {len(records)} records')

    # The operator's login name shows up in shell prompts and hostnames, not
    # just in /Users/ paths, and no pattern can know it in advance. Rather than
    # rely on someone remembering --redact-extra, learn it: any name seen in a
    # /Users/ path is the operator's, so redact it everywhere it appears.
    if do_redact:
        blob = json.dumps(records)[:8_000_000]
        names = set(re.findall(r'/Users/([A-Za-z0-9._-]{3,})', blob))
        names.discard('OPERATOR')
        for name in sorted(names):
            REDACTIONS.append((re.compile(r'\b' + re.escape(name) + r'\b', re.I),
                               'OPERATOR'))
        if names:
            print(f'  redacting login name(s): {", ".join(sorted(names))}')

    if args.only in (None, 'transcript'):
        count = write_transcript(records, outdir / 'transcript.md', images_dir,
                                 args.cap, not args.no_images, do_redact)
        size = (outdir / 'transcript.md').stat().st_size
        print(f'  transcript.md   {size:>9,} bytes, {count} images')

    if args.only in (None, 'raw'):
        write_raw(records, outdir / 'session.jsonl', do_redact)
        size = (outdir / 'session.jsonl').stat().st_size
        print(f'  session.jsonl   {size:>9,} bytes')


if __name__ == '__main__':
    main()
