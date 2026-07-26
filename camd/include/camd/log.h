// Rotating, timestamped file logger.
//
// The brief calls for every state change to be recoverable on Monday morning, so
// this is intentionally boring: line-oriented, flushed on write, size-rotated
// with a bounded number of files. It never throws and never blocks on anything
// but its own mutex — a logger that can wedge the daemon would defeat the point.
#pragma once

#include <cstdint>
#include <fstream>
#include <mutex>
#include <string>

namespace camd {

enum class LogLevel { Trace = 0, Debug, Info, Warn, Error };

LogLevel logLevelFromString(const std::string& s, LogLevel def = LogLevel::Info);
const char* logLevelName(LogLevel l);

class Logger {
public:
    static Logger& instance();

    // dir is created if missing. If it cannot be opened the logger degrades to
    // stderr only rather than failing startup.
    void configure(const std::string& dir, LogLevel level,
                   std::uint64_t maxSizeBytes, int maxFiles);

    void setAlsoStderr(bool on) { alsoStderr_ = on; }
    LogLevel level() const { return level_; }
    bool enabled(LogLevel l) const { return static_cast<int>(l) >= static_cast<int>(level_); }

    // `subject` is a short stable tag — a camera id, "http", "ws", "sdk" — so the
    // log can be grepped per camera during a postmortem.
    void write(LogLevel l, std::string_view subject, std::string_view message);

private:
    Logger() = default;
    void rotateIfNeededLocked(std::size_t incoming);

    std::mutex mu_;
    std::ofstream out_;
    std::string dir_;
    std::string path_;
    LogLevel level_{LogLevel::Info};
    std::uint64_t maxSize_{20ull * 1024 * 1024};
    int maxFiles_{30};
    std::uint64_t written_{0};
    bool alsoStderr_{true};
};

void logf(LogLevel level, std::string_view subject, const char* fmt, ...);

#define CAMD_LOG(level, subject, ...)                                     \
    do {                                                                  \
        if (::camd::Logger::instance().enabled(level))                     \
            ::camd::logf((level), (subject), __VA_ARGS__);                 \
    } while (0)

#define LOG_TRACE(subject, ...) CAMD_LOG(::camd::LogLevel::Trace, subject, __VA_ARGS__)
#define LOG_DEBUG(subject, ...) CAMD_LOG(::camd::LogLevel::Debug, subject, __VA_ARGS__)
#define LOG_INFO(subject, ...)  CAMD_LOG(::camd::LogLevel::Info,  subject, __VA_ARGS__)
#define LOG_WARN(subject, ...)  CAMD_LOG(::camd::LogLevel::Warn,  subject, __VA_ARGS__)
#define LOG_ERROR(subject, ...) CAMD_LOG(::camd::LogLevel::Error, subject, __VA_ARGS__)

}  // namespace camd
