#include "camd/log.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <sys/time.h>

namespace camd {
namespace fs = std::filesystem;

LogLevel logLevelFromString(const std::string& s, LogLevel def) {
    if (s == "trace") return LogLevel::Trace;
    if (s == "debug") return LogLevel::Debug;
    if (s == "info")  return LogLevel::Info;
    if (s == "warn" || s == "warning") return LogLevel::Warn;
    if (s == "error") return LogLevel::Error;
    return def;
}

const char* logLevelName(LogLevel l) {
    switch (l) {
        case LogLevel::Trace: return "TRACE";
        case LogLevel::Debug: return "DEBUG";
        case LogLevel::Info:  return "INFO ";
        case LogLevel::Warn:  return "WARN ";
        case LogLevel::Error: return "ERROR";
    }
    return "?????";
}

Logger& Logger::instance() {
    static Logger logger;
    return logger;
}

void Logger::configure(const std::string& dir, LogLevel level,
                       std::uint64_t maxSizeBytes, int maxFiles) {
    std::lock_guard<std::mutex> lock(mu_);
    level_ = level;
    maxSize_ = maxSizeBytes > 0 ? maxSizeBytes : maxSize_;
    maxFiles_ = maxFiles > 0 ? maxFiles : maxFiles_;
    dir_ = dir;

    std::error_code ec;
    fs::create_directories(dir_, ec);
    path_ = (fs::path(dir_) / "camd.log").string();

    out_.close();
    out_.clear();
    out_.open(path_, std::ios::app);
    if (out_.is_open()) {
        written_ = static_cast<std::uint64_t>(fs::file_size(path_, ec));
        if (ec) written_ = 0;
    } else {
        // Degrade rather than refuse to start: a daemon that will not run
        // because it cannot write a log is worse than one that logs to stderr.
        std::fprintf(stderr, "camd: cannot open log file %s, logging to stderr only\n",
                     path_.c_str());
        alsoStderr_ = true;
    }
}

void Logger::rotateIfNeededLocked(std::size_t incoming) {
    if (!out_.is_open() || path_.empty()) return;
    if (written_ + incoming <= maxSize_) return;

    out_.close();
    std::error_code ec;

    // camd.log -> camd.log.1, camd.log.1 -> camd.log.2, ... dropping the oldest.
    std::string oldest = path_ + "." + std::to_string(maxFiles_);
    fs::remove(oldest, ec);
    for (int i = maxFiles_ - 1; i >= 1; --i) {
        std::string from = path_ + "." + std::to_string(i);
        std::string to = path_ + "." + std::to_string(i + 1);
        if (fs::exists(from, ec)) fs::rename(from, to, ec);
    }
    fs::rename(path_, path_ + ".1", ec);

    out_.clear();
    out_.open(path_, std::ios::trunc);
    written_ = 0;
}

void Logger::write(LogLevel l, std::string_view subject, std::string_view message) {
    if (!enabled(l)) return;

    // Millisecond-resolution local timestamp with UTC offset, so log lines can be
    // correlated against a shoot running clock without ambiguity.
    struct timeval tv{};
    gettimeofday(&tv, nullptr);
    std::time_t secs = tv.tv_sec;
    std::tm tmv{};
    localtime_r(&secs, &tmv);

    char stamp[64];
    std::size_t n = std::strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%S", &tmv);
    std::snprintf(stamp + n, sizeof(stamp) - n, ".%03d", static_cast<int>(tv.tv_usec / 1000));

    std::string line;
    line.reserve(64 + subject.size() + message.size());
    line += stamp;
    line += ' ';
    line += logLevelName(l);
    line += " [";
    line.append(subject);
    line += "] ";
    line.append(message);
    line += '\n';

    std::lock_guard<std::mutex> lock(mu_);
    if (out_.is_open()) {
        rotateIfNeededLocked(line.size());
        out_ << line;
        out_.flush();
        written_ += line.size();
    }
    if (alsoStderr_ || !out_.is_open()) {
        std::fwrite(line.data(), 1, line.size(), stderr);
    }
}

void logf(LogLevel level, std::string_view subject, const char* fmt, ...) {
    char stack[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = std::vsnprintf(stack, sizeof(stack), fmt, ap);
    va_end(ap);
    if (n < 0) return;

    if (static_cast<std::size_t>(n) < sizeof(stack)) {
        Logger::instance().write(level, subject, std::string_view(stack, static_cast<std::size_t>(n)));
        return;
    }
    std::string heap(static_cast<std::size_t>(n) + 1, '\0');
    va_start(ap, fmt);
    std::vsnprintf(heap.data(), heap.size(), fmt, ap);
    va_end(ap);
    Logger::instance().write(level, subject, std::string_view(heap.data(), static_cast<std::size_t>(n)));
}

}  // namespace camd
