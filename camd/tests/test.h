// Minimal test harness. Enough structure to name cases and report the first
// failing assertion with a file and line; no more than that.
#pragma once

#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace t {

struct Case {
    std::string name;
    std::function<void()> fn;
};

std::vector<Case>& registry();
bool add(const std::string& name, std::function<void()> fn);
int runAll();

struct Failure : std::runtime_error {
    using std::runtime_error::runtime_error;
};

[[noreturn]] void fail(const char* file, int line, const std::string& msg);

template <typename A, typename B>
void checkEq(const char* file, int line, const char* exprA, const char* exprB,
             const A& a, const B& b) {
    if (!(a == b)) {
        std::ostringstream ss;
        ss << exprA << " == " << exprB << "\n      left:  " << a << "\n      right: " << b;
        fail(file, line, ss.str());
    }
}

}  // namespace t

#define CHECK(cond)                                                    \
    do {                                                               \
        if (!(cond)) ::t::fail(__FILE__, __LINE__, "CHECK(" #cond ")"); \
    } while (0)

#define CHECK_EQ(a, b) ::t::checkEq(__FILE__, __LINE__, #a, #b, (a), (b))

#define TEST(name)                                              \
    static void name();                                         \
    static const bool t_reg_##name = ::t::add(#name, name);     \
    static void name()
