// camd entry point.
//
// Startup order matters: config, then logging (so config errors are still
// visible), then the backend, then the HTTP surface. Anything fatal is reported
// on stderr as well as the log, because under launchd the log file is the only
// record and a silent exit is the hardest failure to diagnose.
#include <atomic>
#include <csignal>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "camd/api.h"
#include "camd/config.h"
#include "camd/http.h"
#include "camd/log.h"
#include "camd/registry.h"
#include "camd/ws.h"

namespace {

std::atomic<bool> g_stop{false};

void onSignal(int sig) {
    (void)sig;
    g_stop = true;
}

void usage() {
    std::cout <<
        "camd — Sony camera control daemon\n"
        "\n"
        "Usage: camd [options]\n"
        "  --config <path>   config file (default ./config/cambridge.json)\n"
        "  --fake            run with the in-memory backend instead of the Sony SDK.\n"
        "                    Serves three simulated bodies so the UI and the Node\n"
        "                    layer can be exercised without the studio rig.\n"
        "  --port <n>        override camd.restPort\n"
        "  --verbose         force debug logging regardless of config\n"
        "  --help            this text\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::string configPath = "./config/cambridge.json";
    bool fake = false;
    bool verbose = false;
    int portOverride = 0;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) { configPath = argv[++i]; }
        else if (arg == "--fake") { fake = true; }
        else if (arg == "--verbose") { verbose = true; }
        else if (arg == "--port" && i + 1 < argc) { portOverride = std::atoi(argv[++i]); }
        else if (arg == "--help" || arg == "-h") { usage(); return 0; }
        else {
            std::cerr << "camd: unknown argument '" << arg << "'\n\n";
            usage();
            return 2;
        }
    }

    camd::Config cfg;
    std::vector<std::string> errors;
    const bool configOk = camd::Config::loadFile(configPath, cfg, errors);

    camd::Logger::instance().configure(
        cfg.logging.dir,
        verbose ? camd::LogLevel::Debug : camd::logLevelFromString(cfg.logging.level),
        cfg.logging.maxSizeBytes, cfg.logging.maxFiles);

    if (!configOk) {
        // Report every problem at once: fixing config one error per restart at 8am
        // on a Sunday is not a workflow anyone should have to use.
        std::cerr << "camd: configuration problems in " << configPath << ":\n";
        for (const auto& e : errors) {
            std::cerr << "  - " << e << "\n";
            LOG_ERROR("config", "%s", e.c_str());
        }
        if (cfg.cameras.empty()) {
            std::cerr << "camd: no usable camera entries, refusing to start\n";
            return 1;
        }
        std::cerr << "camd: continuing with " << cfg.cameras.size()
                  << " camera entr" << (cfg.cameras.size() == 1 ? "y" : "ies")
                  << " — fix the above when you can\n";
        LOG_WARN("config", "starting despite %zu configuration problem(s)", errors.size());
    }

    if (portOverride > 0) cfg.restPort = portOverride;

    LOG_INFO("camd", "starting: %zu camera(s), REST on %s:%d, WS at %s",
             cfg.cameras.size(), cfg.bind.c_str(), cfg.restPort, cfg.wsPath.c_str());

    std::unique_ptr<camd::Backend> backend;
    if (fake) {
        // Mirrors the studio: one full-frame body and two Super 35.
        std::vector<camd::DiscoveredCamera> present;
        const char* macs[] = {"AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"};
        const char* models[] = {"ILME-FX3", "ILME-FX30", "ILME-FX30"};
        for (int i = 0; i < 3; ++i) {
            camd::DiscoveredCamera d;
            d.mac = macs[i];
            d.model = models[i];
            d.ip = "127.0.0." + std::to_string(51 + i);
            d.name = models[i];
            d.sshRequired = true;
            present.push_back(d);
        }
        // Let the config's own MACs win when they are filled in, so --fake can be
        // pointed at a realistic config too.
        for (std::size_t i = 0; i < cfg.cameras.size() && i < present.size(); ++i) {
            if (!cfg.cameras[i].mac.empty()) present[i].mac = cfg.cameras[i].mac;
            if (!cfg.cameras[i].model.empty()) present[i].model = cfg.cameras[i].model;
            if (!cfg.cameras[i].ip.empty()) present[i].ip = cfg.cameras[i].ip;
        }
        backend = camd::makeFakeBackend(std::move(present));
    } else {
        backend = camd::makeSonyBackend();
    }

    camd::Registry registry(cfg, std::move(backend));
    camd::ws::Hub hub;
    registry.setSink([&hub](const std::string& text) { hub.broadcast(text); });

    std::string err;
    if (!registry.start(err)) {
        std::cerr << "camd: cannot start backend: " << err << "\n";
        LOG_ERROR("camd", "backend start failed: %s", err.c_str());
        return 1;
    }

    camd::http::Server server;
    camd::Api api(registry, hub);
    api.install(server, cfg.wsPath);

    if (!server.start(cfg.bind, cfg.restPort)) {
        std::cerr << "camd: cannot bind " << cfg.bind << ":" << cfg.restPort
                  << " — is another camd already running?\n";
        registry.stop();
        return 1;
    }

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    // A dropped WebSocket or MJPEG client must not kill the daemon.
    std::signal(SIGPIPE, SIG_IGN);

    LOG_INFO("camd", "ready");
    std::cout << "camd ready on http://" << cfg.bind << ":" << server.port()
              << " (ws " << cfg.wsPath << ")\n";

    while (!g_stop) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    LOG_INFO("camd", "shutting down");
    std::cout << "camd shutting down\n";
    server.stop();
    hub.shutdown();
    registry.stop();
    LOG_INFO("camd", "stopped");
    return 0;
}
