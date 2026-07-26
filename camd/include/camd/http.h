// Minimal HTTP/1.1 server: routing, streaming responses, WebSocket upgrade.
//
// Thread per connection. The client count here is a handful (one Node bridge,
// maybe a curl or a browser tab), so a thread each is simpler to reason about
// than an event loop — and simple is the priority for code that has to stay up
// through a service.
//
// Read timeouts are set on every accepted socket so a stalled client cannot hold
// a thread indefinitely.
#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace camd::http {

// Case-insensitive key comparison for headers.
struct CaseInsensitiveLess {
    bool operator()(const std::string& a, const std::string& b) const;
};
using Headers = std::map<std::string, std::string, CaseInsensitiveLess>;

struct Request {
    std::string method;
    std::string path;                             // decoded, no query string
    std::string rawQuery;
    std::map<std::string, std::string> query;
    std::map<std::string, std::string> params;     // from :placeholders in the route
    Headers headers;
    std::string body;

    std::string param(const std::string& k) const;
    std::string queryValue(const std::string& k, const std::string& def = {}) const;
};

struct Response {
    int status = 200;
    Headers headers;
    std::string body;

    void json(int code, const std::string& serialised);
    void text(int code, const std::string& s);
    // Standard error envelope so the Node layer can always read `error`.
    void error(int code, const std::string& message);
};

// Owns an accepted socket. Handed to streaming and WebSocket handlers, which may
// keep it alive beyond the normal request cycle.
class Connection {
public:
    explicit Connection(int fd);
    ~Connection();
    Connection(const Connection&) = delete;
    Connection& operator=(const Connection&) = delete;
    Connection(Connection&& other) noexcept;

    bool valid() const { return fd_ >= 0; }
    int fd() const { return fd_; }

    // Writes the whole buffer or returns false. Short writes are retried.
    bool writeAll(const char* data, std::size_t len);
    bool writeAll(const std::string& s) { return writeAll(s.data(), s.size()); }

    // Reads up to len bytes. Returns bytes read, 0 on clean close, -1 on error
    // (including timeout, which callers treat as "no data yet").
    long read(char* buf, std::size_t len);

    void setReadTimeout(int ms);
    void shutdownWrite();
    void close();

private:
    int fd_{-1};
};

using Handler = std::function<void(const Request&, Response&)>;
// Streaming handlers own the response entirely: they must write status line and
// headers themselves. Used for MJPEG, which never completes normally.
using StreamHandler = std::function<void(const Request&, Connection&)>;
// Called after a successful RFC 6455 handshake, on the connection's own thread.
using WebSocketHandler = std::function<void(const Request&, Connection&&)>;

class Server {
public:
    Server();
    ~Server();

    void route(std::string method, std::string pattern, Handler h);
    void routeStream(std::string method, std::string pattern, StreamHandler h);
    // Registers the single WebSocket endpoint.
    void webSocket(std::string path, WebSocketHandler h);

    // Binds and starts accepting on a background thread. Returns false if the
    // socket cannot be bound — the caller should treat that as fatal at startup.
    bool start(const std::string& bindAddr, int port);
    void stop();
    bool running() const { return running_; }
    int port() const { return boundPort_; }

private:
    struct Route {
        std::string method;
        std::vector<std::string> segments;  // ":name" marks a parameter
        Handler handler;
        StreamHandler stream;
        bool isStream = false;
    };

    void acceptLoop();
    void serveConnection(int fd);
    bool dispatch(const Request& req, Connection& conn);
    const Route* match(const std::string& method, const std::string& path,
                       std::map<std::string, std::string>& params) const;

    int listenFd_{-1};
    int boundPort_{0};
    std::atomic<bool> running_{false};
    std::thread acceptThread_;
    std::vector<Route> routes_;
    std::string wsPath_;
    WebSocketHandler wsHandler_;
};

// Exposed for unit testing.
std::string urlDecode(std::string_view in);
std::map<std::string, std::string> parseQuery(std::string_view raw);
bool parseRequestHead(std::string_view head, Request& out);
std::vector<std::string> splitPath(std::string_view path);
const char* statusText(int code);

}  // namespace camd::http
