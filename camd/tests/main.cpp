#include "test.h"

#include <cstdio>

#include "camd/log.h"

namespace t {

std::vector<Case>& registry() {
    static std::vector<Case> cases;
    return cases;
}

bool add(const std::string& name, std::function<void()> fn) {
    registry().push_back(Case{name, std::move(fn)});
    return true;
}

void fail(const char* file, int line, const std::string& msg) {
    std::ostringstream ss;
    ss << file << ":" << line << ": " << msg;
    throw Failure(ss.str());
}

int runAll() {
    int passed = 0;
    std::vector<std::string> failures;
    for (auto& c : registry()) {
        try {
            c.fn();
            std::printf("  \033[32mpass\033[0m %s\n", c.name.c_str());
            ++passed;
        } catch (const Failure& f) {
            std::printf("  \033[31mFAIL\033[0m %s\n        %s\n", c.name.c_str(), f.what());
            failures.push_back(c.name);
        } catch (const std::exception& e) {
            std::printf("  \033[31mFAIL\033[0m %s\n        unexpected exception: %s\n",
                        c.name.c_str(), e.what());
            failures.push_back(c.name);
        }
    }
    std::printf("\n%d passed, %zu failed, %zu total\n", passed, failures.size(),
                registry().size());
    return failures.empty() ? 0 : 1;
}

}  // namespace t

int main() {
    // Keep the test output readable: log to a scratch dir at warn level and do not
    // duplicate onto stderr.
    camd::Logger::instance().configure("./test-logs", camd::LogLevel::Warn,
                                       1024 * 1024, 2);
    camd::Logger::instance().setAlsoStderr(false);
    std::printf("camd tests\n\n");
    return t::runAll();
}
