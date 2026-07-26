#include "camd/http.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <utility>

#include "camd/log.h"
#include "camd/sha1.h"

namespace camd::http {
namespace {

char lowerAscii(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

std::string trim(std::string_view s) {
    std::size_t b = 0, e = s.size();
    while (b < e && (s[b] == ' ' || s[b] == '\t')) ++b;
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r')) --e;
    return std::string(s.substr(b, e - b));
}

int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

constexpr std::size_t kMaxHeadBytes = 16 * 1024;
constexpr std::size_t kMaxBodyBytes = 8 * 1024 * 1024;  // liveview POSTs never happen; be generous but bounded

}  // namespace

bool CaseInsensitiveLess::operator()(const std::string& a, const std::string& b) const {
    return std::lexicographical_compare(
        a.begin(), a.end(), b.begin(), b.end(),
        [](char x, char y) { return lowerAscii(x) < lowerAscii(y); });
}

std::string Request::param(const std::string& k) const {
    auto it = params.find(k);
    return it == params.end() ? std::string{} : it->second;
}

std::string Request::queryValue(const std::string& k, const std::string& def) const {
    auto it = query.find(k);
    return it == query.end() ? def : it->second;
}

void Response::json(int code, const std::string& serialised) {
    status = code;
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = serialised;
}

void Response::text(int code, const std::string& s) {
    status = code;
    headers["Content-Type"] = "text/plain; charset=utf-8";
    body = s;
}

void Response::error(int code, const std::string& message) {
    // One envelope shape for every failure so the Node layer never has to guess.
    std::string escaped;
    for (char c : message) {
        if (c == '"' || c == '\\') escaped.push_back('\\');
        if (c == '\n') { escaped += "\\n"; continue; }
        escaped.push_back(c);
    }
    json(code, "{\"error\":\"" + escaped + "\"}");
}

std::string urlDecode(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '+') { out.push_back(' '); continue; }
        if (in[i] == '%' && i + 2 < in.size()) {
            int hi = hexVal(in[i + 1]), lo = hexVal(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>(hi * 16 + lo));
                i += 2;
                continue;
            }
        }
        out.push_back(in[i]);
    }
    return out;
}

std::map<std::string, std::string> parseQuery(std::string_view raw) {
    std::map<std::string, std::string> out;
    std::size_t pos = 0;
    while (pos < raw.size()) {
        std::size_t amp = raw.find('&', pos);
        if (amp == std::string_view::npos) amp = raw.size();
        std::string_view pair = raw.substr(pos, amp - pos);
        if (!pair.empty()) {
            std::size_t eq = pair.find('=');
            if (eq == std::string_view::npos) {
                out[urlDecode(pair)] = "";
            } else {
                out[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
            }
        }
        pos = amp + 1;
    }
    return out;
}

std::vector<std::string> splitPath(std::string_view path) {
    std::vector<std::string> out;
    std::size_t pos = 0;
    while (pos < path.size()) {
        while (pos < path.size() && path[pos] == '/') ++pos;
        if (pos >= path.size()) break;
        std::size_t next = path.find('/', pos);
        if (next == std::string_view::npos) next = path.size();
        out.emplace_back(path.substr(pos, next - pos));
        pos = next;
    }
    return out;
}

bool parseRequestHead(std::string_view head, Request& out) {
    std::size_t lineEnd = head.find("\r\n");
    if (lineEnd == std::string_view::npos) return false;
    std::string_view requestLine = head.substr(0, lineEnd);

    std::size_t sp1 = requestLine.find(' ');
    if (sp1 == std::string_view::npos) return false;
    std::size_t sp2 = requestLine.find(' ', sp1 + 1);
    if (sp2 == std::string_view::npos) return false;

    out.method = std::string(requestLine.substr(0, sp1));
    std::string_view target = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);

    std::size_t q = target.find('?');
    if (q == std::string_view::npos) {
        out.path = urlDecode(target);
    } else {
        out.path = urlDecode(target.substr(0, q));
        out.rawQuery = std::string(target.substr(q + 1));
        out.query = parseQuery(out.rawQuery);
    }

    std::size_t pos = lineEnd + 2;
    while (pos < head.size()) {
        std::size_t end = head.find("\r\n", pos);
        if (end == std::string_view::npos) end = head.size();
        if (end == pos) break;  // blank line
        std::string_view line = head.substr(pos, end - pos);
        std::size_t colon = line.find(':');
        if (colon != std::string_view::npos) {
            out.headers[trim(line.substr(0, colon))] = trim(line.substr(colon + 1));
        }
        pos = end + 2;
    }
    return !out.method.empty() && !out.path.empty();
}

const char* statusText(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 413: return "Payload Too Large";
        case 422: return "Unprocessable Entity";
        case 500: return "Internal Server Error";
        case 503: return "Service Unavailable";
        case 504: return "Gateway Timeout";
        default:  return "Status";
    }
}

// --- Connection -------------------------------------------------------------

Connection::Connection(int fd) : fd_(fd) {}
Connection::~Connection() { close(); }

Connection::Connection(Connection&& other) noexcept : fd_(other.fd_) { other.fd_ = -1; }

void Connection::close() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
}

void Connection::shutdownWrite() {
    if (fd_ >= 0) ::shutdown(fd_, SHUT_WR);
}

void Connection::setReadTimeout(int ms) {
    if (fd_ < 0) return;
    struct timeval tv{};
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
}

bool Connection::writeAll(const char* data, std::size_t len) {
    if (fd_ < 0) return false;
    std::size_t sent = 0;
    while (sent < len) {
        // MSG_NOSIGNAL is Linux; macOS uses SO_NOSIGPIPE, set at accept time.
#ifdef MSG_NOSIGNAL
        ssize_t n = ::send(fd_, data + sent, len - sent, MSG_NOSIGNAL);
#else
        ssize_t n = ::send(fd_, data + sent, len - sent, 0);
#endif
        if (n > 0) {
            sent += static_cast<std::size_t>(n);
            continue;
        }
        if (n < 0 && (errno == EINTR)) continue;
        return false;
    }
    return true;
}

long Connection::read(char* buf, std::size_t len) {
    if (fd_ < 0) return -1;
    while (true) {
        ssize_t n = ::recv(fd_, buf, len, 0);
        if (n >= 0) return static_cast<long>(n);
        if (errno == EINTR) continue;
        return -1;
    }
}

// --- Server -----------------------------------------------------------------

Server::Server() = default;

Server::~Server() { stop(); }

void Server::route(std::string method, std::string pattern, Handler h) {
    Route r;
    r.method = std::move(method);
    r.segments = splitPath(pattern);
    r.handler = std::move(h);
    routes_.push_back(std::move(r));
}

void Server::routeStream(std::string method, std::string pattern, StreamHandler h) {
    Route r;
    r.method = std::move(method);
    r.segments = splitPath(pattern);
    r.stream = std::move(h);
    r.isStream = true;
    routes_.push_back(std::move(r));
}

void Server::webSocket(std::string path, WebSocketHandler h) {
    wsPath_ = std::move(path);
    wsHandler_ = std::move(h);
}

const Server::Route* Server::match(const std::string& method, const std::string& path,
                                   std::map<std::string, std::string>& params) const {
    auto segs = splitPath(path);
    const Route* methodMismatch = nullptr;
    for (const auto& r : routes_) {
        if (r.segments.size() != segs.size()) continue;
        std::map<std::string, std::string> got;
        bool ok = true;
        for (std::size_t i = 0; i < segs.size(); ++i) {
            const std::string& pat = r.segments[i];
            if (!pat.empty() && pat[0] == ':') {
                got[pat.substr(1)] = segs[i];
            } else if (pat != segs[i]) {
                ok = false;
                break;
            }
        }
        if (!ok) continue;
        if (r.method != method) { methodMismatch = &r; continue; }
        params = std::move(got);
        return &r;
    }
    // Signal "path exists, wrong verb" so dispatch can answer 405 not 404.
    if (methodMismatch) params["__methodMismatch"] = "1";
    return nullptr;
}

bool Server::start(const std::string& bindAddr, int port) {
    listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd_ < 0) {
        LOG_ERROR("http", "socket() failed: %s", std::strerror(errno));
        return false;
    }
    int one = 1;
    ::setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (::inet_pton(AF_INET, bindAddr.c_str(), &addr.sin_addr) != 1) {
        LOG_ERROR("http", "invalid bind address '%s'", bindAddr.c_str());
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }
    if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        LOG_ERROR("http", "bind %s:%d failed: %s", bindAddr.c_str(), port,
                  std::strerror(errno));
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }
    if (::listen(listenFd_, 32) != 0) {
        LOG_ERROR("http", "listen failed: %s", std::strerror(errno));
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }

    // Resolve the actual port so port 0 can be used in tests.
    sockaddr_in actual{};
    socklen_t alen = sizeof(actual);
    if (::getsockname(listenFd_, reinterpret_cast<sockaddr*>(&actual), &alen) == 0) {
        boundPort_ = ntohs(actual.sin_port);
    } else {
        boundPort_ = port;
    }

    running_ = true;
    acceptThread_ = std::thread([this] { acceptLoop(); });
    LOG_INFO("http", "listening on %s:%d", bindAddr.c_str(), boundPort_);
    return true;
}

void Server::stop() {
    if (!running_.exchange(false)) return;
    if (listenFd_ >= 0) {
        ::shutdown(listenFd_, SHUT_RDWR);
        ::close(listenFd_);
        listenFd_ = -1;
    }
    if (acceptThread_.joinable()) acceptThread_.join();
    LOG_INFO("http", "stopped");
}

void Server::acceptLoop() {
    while (running_) {
        int fd = ::accept(listenFd_, nullptr, nullptr);
        if (fd < 0) {
            if (!running_) break;
            if (errno == EINTR) continue;
            continue;
        }
#ifdef SO_NOSIGPIPE
        int one = 1;
        ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
        int nodelay = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

        // Detached: a client that stalls is bounded by the read timeout, and a
        // long-lived MJPEG or WebSocket connection must outlive this loop
        // iteration anyway.
        std::thread([this, fd] { serveConnection(fd); }).detach();
    }
}

void Server::serveConnection(int fd) {
    Connection conn(fd);
    conn.setReadTimeout(15000);

    std::string buf;
    std::size_t headEnd = std::string::npos;
    char chunk[4096];

    // Read until end of headers.
    while (true) {
        headEnd = buf.find("\r\n\r\n");
        if (headEnd != std::string::npos) break;
        if (buf.size() > kMaxHeadBytes) return;
        long n = conn.read(chunk, sizeof(chunk));
        if (n <= 0) return;
        buf.append(chunk, static_cast<std::size_t>(n));
    }

    Request req;
    if (!parseRequestHead(std::string_view(buf).substr(0, headEnd + 2), req)) {
        Response bad;
        bad.error(400, "malformed request");
        std::string out = "HTTP/1.1 400 Bad Request\r\nContent-Length: " +
                          std::to_string(bad.body.size()) +
                          "\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + bad.body;
        conn.writeAll(out);
        return;
    }

    // Body, if any.
    std::size_t bodyStart = headEnd + 4;
    std::size_t contentLength = 0;
    auto clIt = req.headers.find("Content-Length");
    if (clIt != req.headers.end()) {
        contentLength = static_cast<std::size_t>(std::strtoull(clIt->second.c_str(), nullptr, 10));
    }
    if (contentLength > kMaxBodyBytes) {
        std::string out = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        conn.writeAll(out);
        return;
    }
    req.body = buf.substr(std::min(bodyStart, buf.size()));
    while (req.body.size() < contentLength) {
        long n = conn.read(chunk, sizeof(chunk));
        if (n <= 0) break;
        req.body.append(chunk, static_cast<std::size_t>(n));
    }
    if (req.body.size() > contentLength) req.body.resize(contentLength);

    dispatch(req, conn);
}

bool Server::dispatch(const Request& reqIn, Connection& conn) {
    Request req = reqIn;

    // WebSocket upgrade takes precedence on its own path.
    if (!wsPath_.empty() && req.path == wsPath_ && wsHandler_) {
        auto up = req.headers.find("Upgrade");
        auto key = req.headers.find("Sec-WebSocket-Key");
        bool wantsWs = up != req.headers.end() &&
                       up->second.size() >= 9 &&
                       lowerAscii(up->second[0]) == 'w';
        if (wantsWs && key != req.headers.end()) {
            std::string accept = crypto::websocketAccept(key->second);
            std::string handshake =
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            if (!conn.writeAll(handshake)) return false;
            // The hub owns the socket from here; it blocks on this thread.
            wsHandler_(req, std::move(conn));
            return true;
        }
        Response res;
        res.error(400, "websocket upgrade expected on " + wsPath_);
        std::string out = "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n"
                          "Content-Length: " + std::to_string(res.body.size()) +
                          "\r\nConnection: close\r\n\r\n" + res.body;
        conn.writeAll(out);
        return true;
    }

    std::map<std::string, std::string> params;
    const Route* r = match(req.method, req.path, params);

    if (!r) {
        Response res;
        bool wrongVerb = params.count("__methodMismatch") > 0;
        if (req.method == "OPTIONS") {
            res.status = 204;
        } else if (wrongVerb) {
            res.error(405, "method " + req.method + " not allowed for " + req.path);
        } else {
            res.error(404, "no route for " + req.path);
        }
        std::string out = "HTTP/1.1 " + std::to_string(res.status) + " " +
                          statusText(res.status) + "\r\n";
        for (const auto& [k, v] : res.headers) out += k + ": " + v + "\r\n";
        out += "Content-Length: " + std::to_string(res.body.size()) + "\r\n";
        out += "Connection: close\r\n\r\n";
        out += res.body;
        conn.writeAll(out);
        return true;
    }

    req.params = std::move(params);

    if (r->isStream) {
        r->stream(req, conn);
        return true;
    }

    Response res;
    try {
        r->handler(req, res);
    } catch (const std::exception& e) {
        // A handler throwing must not take the daemon with it.
        LOG_ERROR("http", "handler for %s %s threw: %s", req.method.c_str(),
                  req.path.c_str(), e.what());
        res = Response{};
        res.error(500, std::string("internal error: ") + e.what());
    } catch (...) {
        LOG_ERROR("http", "handler for %s %s threw a non-exception",
                  req.method.c_str(), req.path.c_str());
        res = Response{};
        res.error(500, "internal error");
    }

    std::string out = "HTTP/1.1 " + std::to_string(res.status) + " " +
                      statusText(res.status) + "\r\n";
    for (const auto& [k, v] : res.headers) out += k + ": " + v + "\r\n";
    out += "Content-Length: " + std::to_string(res.body.size()) + "\r\n";
    out += "Connection: close\r\n\r\n";
    out += res.body;
    conn.writeAll(out);
    return true;
}

}  // namespace camd::http
