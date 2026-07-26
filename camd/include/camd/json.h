// Minimal JSON value, parser and serialiser.
//
// Deliberately hand-rolled rather than vendored: camd's dependency surface is a
// reliability concern (see camd/README.md on the SDK's extern "C" symbol
// namespace), and the config file plus REST responses are all this needs to
// handle. Everything here is platform-independent and unit-tested.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace camd::json {

class Value;
using Array = std::vector<Value>;
using Object = std::map<std::string, Value>;

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
public:
    Value() = default;
    Value(std::nullptr_t) {}
    Value(bool b) : t_(Type::Bool), b_(b) {}
    Value(double d) : t_(Type::Number), n_(d) {}
    Value(int i) : t_(Type::Number), n_(static_cast<double>(i)) {}
    Value(std::int64_t i) : t_(Type::Number), n_(static_cast<double>(i)) {}
    Value(std::uint64_t i) : t_(Type::Number), n_(static_cast<double>(i)) {}
    Value(const char* s) : t_(Type::String), s_(s ? s : "") {}
    Value(std::string s) : t_(Type::String), s_(std::move(s)) {}
    Value(Array a);
    Value(Object o);

    // Deep copy: containers are held behind unique_ptr to an incomplete type,
    // so these are defined out-of-line where Array/Object are complete.
    Value(const Value& other);
    Value& operator=(const Value& other);
    Value(Value&&) noexcept;
    Value& operator=(Value&&) noexcept;
    ~Value();

    Type type() const { return t_; }
    bool isNull()   const { return t_ == Type::Null; }
    bool isBool()   const { return t_ == Type::Bool; }
    bool isNumber() const { return t_ == Type::Number; }
    bool isString() const { return t_ == Type::String; }
    bool isArray()  const { return t_ == Type::Array; }
    bool isObject() const { return t_ == Type::Object; }

    bool         asBool(bool def = false) const { return isBool() ? b_ : def; }
    double       asNumber(double def = 0.0) const { return isNumber() ? n_ : def; }
    std::int64_t asInt(std::int64_t def = 0) const;
    std::string  asString(std::string def = {}) const { return isString() ? s_ : std::move(def); }

    // Object access. Missing keys yield a shared null Value rather than
    // throwing — config reading is full of optional fields with defaults.
    const Value& operator[](const std::string& key) const;
    bool contains(const std::string& key) const;

    // Array access. Out-of-range yields null.
    const Value& at(std::size_t i) const;
    std::size_t size() const;

    // Mutation, used when building responses.
    void set(const std::string& key, Value v);
    void push(Value v);

    const Array*  array()  const { return a_.get(); }
    const Object* object() const { return o_.get(); }

    static Value makeArray()  { return Value(Array{}); }
    static Value makeObject() { return Value(Object{}); }

    // indent < 0 produces compact output; >= 0 pretty-prints.
    std::string dump(int indent = -1) const;

private:
    void dumpTo(std::string& out, int indent, int depth) const;

    Type t_{Type::Null};
    bool b_{false};
    double n_{0.0};
    std::string s_;
    std::unique_ptr<Array> a_;
    std::unique_ptr<Object> o_;
};

// Returns false and fills `err` with a human-readable message including the
// byte offset. Trailing whitespace is allowed; trailing garbage is not.
bool parse(std::string_view text, Value& out, std::string& err);

// Escapes a string as a JSON string literal, including surrounding quotes.
std::string quote(std::string_view s);

}  // namespace camd::json
