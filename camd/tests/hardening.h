// Shared helpers for the 2026-09-23 audit remediation tests.
#pragma once

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include "camd/camera.h"
#include "camd/registry.h"

namespace hardening {

template <typename Pred>
bool eventually(Pred pred, int timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return pred();
}

// One worker over an empty fake backend: exercises the job queue without any
// camera, real or simulated, being connected.
struct IdleWorker {
    std::unique_ptr<camd::Backend> backend = camd::makeFakeBackend({});
    std::unique_ptr<camd::CameraWorker> worker;
    IdleWorker() {
        std::string e;
        backend->init(e);
        camd::CameraConfig c;
        c.id = "hardening";
        worker = std::make_unique<camd::CameraWorker>(c, backend.get(), nullptr,
                                                      camd::ConnectionConfig{});
        worker->start();
    }
    ~IdleWorker() {
        worker->stop();
        backend->shutdown();
    }
};

}  // namespace hardening
