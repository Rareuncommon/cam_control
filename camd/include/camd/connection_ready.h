#pragma once
#include <chrono>
#include <condition_variable>
#include <mutex>
namespace camd {
// Connect() queues an asynchronous operation; only OnConnected confirms it.
class ConnectionReady {
    std::mutex mutex_;
    std::condition_variable changed_;
    bool connected_ = false, disconnected_ = false;
public:
    void connected() { std::lock_guard<std::mutex> lock(mutex_); connected_ = true; changed_.notify_all(); }
    void disconnected() { std::lock_guard<std::mutex> lock(mutex_); disconnected_ = true; changed_.notify_all(); }
    bool wait(std::chrono::milliseconds timeout) {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait_for(lock, timeout, [&] { return connected_ || disconnected_; });
        return connected_ && !disconnected_;
    }
};
}
