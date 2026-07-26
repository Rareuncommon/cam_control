#include "camd/json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace camd::json {
namespace {
const Value kNull{};
}  // namespace

Value::Value(Array a) : t_(Type::Array), a_(std::make_unique<Array>(std::move(a))) {}
Value::Value(Object o) : t_(Type::Object), o_(std::make_unique<Object>(std::move(o))) {}

Value::Value(const Value& other)
    : t_(other.t_), b_(other.b_), n_(other.n_), s_(other.s_),
      a_(other.a_ ? std::make_unique<Array>(*other.a_) : nullptr),
      o_(other.o_ ? std::make_unique<Object>(*other.o_) : nullptr) {}

Value& Value::operator=(const Value& other) {
    if (this != &other) {
        Value tmp(other);
        *this = std::move(tmp);
    }
    return *this;
}

Value::Value(Value&&) noexcept = default;
Value& Value::operator=(Value&&) noexcept = default;
Value::~Value() = default;

std::int64_t Value::asInt(std::int64_t def) const {
    if (!isNumber()) return def;
    // Reject values a 64-bit integer cannot represent rather than wrapping.
    if (!std::isfinite(n_)) return def;
    return static_cast<std::int64_t>(n_);
}

const Value& Value::operator[](const std::string& key) const {
    if (!o_) return kNull;
    auto it = o_->find(key);
    return it == o_->end() ? kNull : it->second;
}

bool Value::contains(const std::string& key) const {
    return o_ && o_->find(key) != o_->end();
}

const Value& Value::at(std::size_t i) const {
    if (!a_ || i >= a_->size()) return kNull;
    return (*a_)[i];
}

std::size_t Value::size() const {
    if (a_) return a_->size();
    if (o_) return o_->size();
    return 0;
}

void Value::set(const std::string& key, Value v) {
    if (t_ != Type::Object) {
        t_ = Type::Object;
        a_.reset();
        o_ = std::make_unique<Object>();
    }
    (*o_)[key] = std::move(v);
}

void Value::push(Value v) {
    if (t_ != Type::Array) {
        t_ = Type::Array;
        o_.reset();
        a_ = std::make_unique<Array>();
    }
    a_->push_back(std::move(v));
}

std::string quote(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
    return out;
}

namespace {

void appendNumber(std::string& out, double n) {
    if (!std::isfinite(n)) {
        // JSON has no NaN/Infinity. Emitting null is the least surprising
        // choice and keeps output parseable by strict readers.
        out += "null";
        return;
    }
    // Integral values print without a decimal point so property values that are
    // conceptually integers (ISO, shutter numerator) round-trip cleanly.
    if (n == std::floor(n) && std::fabs(n) < 1e15) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(n));
        out += buf;
        return;
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", n);
    out += buf;
}

void newlineIndent(std::string& out, int indent, int depth) {
    if (indent < 0) return;
    out.push_back('\n');
    out.append(static_cast<std::size_t>(indent) * static_cast<std::size_t>(depth), ' ');
}

}  // namespace

void Value::dumpTo(std::string& out, int indent, int depth) const {
    switch (t_) {
        case Type::Null:   out += "null"; return;
        case Type::Bool:   out += b_ ? "true" : "false"; return;
        case Type::Number: appendNumber(out, n_); return;
        case Type::String: out += quote(s_); return;
        case Type::Array: {
            if (!a_ || a_->empty()) { out += "[]"; return; }
            out.push_back('[');
            bool first = true;
            for (const auto& v : *a_) {
                if (!first) out.push_back(',');
                first = false;
                newlineIndent(out, indent, depth + 1);
                v.dumpTo(out, indent, depth + 1);
            }
            newlineIndent(out, indent, depth);
            out.push_back(']');
            return;
        }
        case Type::Object: {
            if (!o_ || o_->empty()) { out += "{}"; return; }
            out.push_back('{');
            bool first = true;
            for (const auto& [k, v] : *o_) {
                if (!first) out.push_back(',');
                first = false;
                newlineIndent(out, indent, depth + 1);
                out += quote(k);
                out.push_back(':');
                if (indent >= 0) out.push_back(' ');
                v.dumpTo(out, indent, depth + 1);
            }
            newlineIndent(out, indent, depth);
            out.push_back('}');
            return;
        }
    }
}

std::string Value::dump(int indent) const {
    std::string out;
    dumpTo(out, indent, 0);
    return out;
}

// --- parser -----------------------------------------------------------------

namespace {

class Parser {
public:
    Parser(std::string_view t) : t_(t) {}

    bool run(Value& out, std::string& err) {
        skipWs();
        if (!parseValue(out)) { err = err_; return false; }
        skipWs();
        if (p_ != t_.size()) { fail("trailing content after top-level value"); err = err_; return false; }
        return true;
    }

private:
    void fail(const std::string& msg) {
        if (err_.empty()) err_ = msg + " at byte " + std::to_string(p_);
    }

    bool eof() const { return p_ >= t_.size(); }
    char peek() const { return t_[p_]; }

    void skipWs() {
        while (!eof()) {
            char c = peek();
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++p_; continue; }
            // Not standard JSON, but our config file uses "$comment" keys rather
            // than // comments, so nothing else is skipped here on purpose.
            break;
        }
    }

    bool literal(std::string_view lit) {
        if (t_.compare(p_, lit.size(), lit) != 0) return false;
        p_ += lit.size();
        return true;
    }

    bool parseValue(Value& out) {
        if (eof()) { fail("unexpected end of input"); return false; }
        switch (peek()) {
            case 'n': if (literal("null"))  { out = Value(); return true; } fail("invalid literal"); return false;
            case 't': if (literal("true"))  { out = Value(true); return true; } fail("invalid literal"); return false;
            case 'f': if (literal("false")) { out = Value(false); return true; } fail("invalid literal"); return false;
            case '"': { std::string s; if (!parseString(s)) return false; out = Value(std::move(s)); return true; }
            case '[': return parseArray(out);
            case '{': return parseObject(out);
            default:  return parseNumber(out);
        }
    }

    bool parseString(std::string& out) {
        if (eof() || peek() != '"') { fail("expected string"); return false; }
        ++p_;
        out.clear();
        while (true) {
            if (eof()) { fail("unterminated string"); return false; }
            char c = t_[p_++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (eof()) { fail("unterminated escape"); return false; }
            char e = t_[p_++];
            switch (e) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    unsigned cp = 0;
                    if (!hex4(cp)) return false;
                    // Surrogate pair.
                    if (cp >= 0xD800 && cp <= 0xDBFF && p_ + 1 < t_.size() &&
                        t_[p_] == '\\' && t_[p_ + 1] == 'u') {
                        std::size_t save = p_;
                        p_ += 2;
                        unsigned lo = 0;
                        if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        } else {
                            p_ = save;
                        }
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: fail("invalid escape sequence"); return false;
            }
        }
    }

    bool hex4(unsigned& out) {
        if (p_ + 4 > t_.size()) { fail("truncated \\u escape"); return false; }
        out = 0;
        for (int i = 0; i < 4; ++i) {
            char c = t_[p_++];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') out |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= static_cast<unsigned>(c - 'A' + 10);
            else { fail("invalid hex digit in \\u escape"); return false; }
        }
        return true;
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool parseNumber(Value& out) {
        std::size_t start = p_;
        if (!eof() && (peek() == '-' || peek() == '+')) ++p_;
        bool anyDigit = false;
        while (!eof() && peek() >= '0' && peek() <= '9') { ++p_; anyDigit = true; }
        if (!eof() && peek() == '.') {
            ++p_;
            while (!eof() && peek() >= '0' && peek() <= '9') { ++p_; anyDigit = true; }
        }
        if (anyDigit && !eof() && (peek() == 'e' || peek() == 'E')) {
            ++p_;
            if (!eof() && (peek() == '-' || peek() == '+')) ++p_;
            while (!eof() && peek() >= '0' && peek() <= '9') ++p_;
        }
        if (!anyDigit) { fail("expected value"); return false; }
        std::string num(t_.substr(start, p_ - start));
        out = Value(std::strtod(num.c_str(), nullptr));
        return true;
    }

    bool parseArray(Value& out) {
        ++p_;  // '['
        Array arr;
        skipWs();
        if (!eof() && peek() == ']') { ++p_; out = Value(std::move(arr)); return true; }
        while (true) {
            skipWs();
            Value v;
            if (!parseValue(v)) return false;
            arr.push_back(std::move(v));
            skipWs();
            if (eof()) { fail("unterminated array"); return false; }
            if (peek() == ',') { ++p_; continue; }
            if (peek() == ']') { ++p_; break; }
            fail("expected ',' or ']' in array");
            return false;
        }
        out = Value(std::move(arr));
        return true;
    }

    bool parseObject(Value& out) {
        ++p_;  // '{'
        Object obj;
        skipWs();
        if (!eof() && peek() == '}') { ++p_; out = Value(std::move(obj)); return true; }
        while (true) {
            skipWs();
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (eof() || peek() != ':') { fail("expected ':' after object key"); return false; }
            ++p_;
            skipWs();
            Value v;
            if (!parseValue(v)) return false;
            obj[std::move(key)] = std::move(v);
            skipWs();
            if (eof()) { fail("unterminated object"); return false; }
            if (peek() == ',') { ++p_; continue; }
            if (peek() == '}') { ++p_; break; }
            fail("expected ',' or '}' in object");
            return false;
        }
        out = Value(std::move(obj));
        return true;
    }

    std::string_view t_;
    std::size_t p_{0};
    std::string err_;
};

}  // namespace

bool parse(std::string_view text, Value& out, std::string& err) {
    err.clear();
    Parser parser(text);
    return parser.run(out, err);
}

}  // namespace camd::json
