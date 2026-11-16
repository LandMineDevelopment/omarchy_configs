"""Exercise the production init boundary against Hyprland's installed ABI API.

Only compositor side effects are replaced. The official client-hash function and
version/dependency macros come from the installed PluginAPI header. A second
harness substitutes the client result to exercise missing-hash rejection.
Neither harness loads a plugin into the compositor or creates a production DSO.
"""
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest


COMMON = r'''
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

HANDLE PHANDLE = nullptr;
HANDLE handleAtHash = nullptr;
HANDLE expectedHandle = nullptr;
std::vector<std::string> effects;
const char* hostHash = nullptr;

APICALL EXPORT const char* __hyprland_api_get_hash() {
    handleAtHash = PHANDLE;
    effects.emplace_back("hostHash");
    return hostHash;
}

void mediaMaskInit() {
    if (PHANDLE != expectedHandle)
        throw std::runtime_error("init received the wrong handle");
    effects.emplace_back("mediaMaskInit");
}

namespace HyprlandAPI {
    APICALL std::vector<SFunctionMatch> findFunctionsByName(HANDLE handle, const std::string& name) {
        if (handle != expectedHandle || name != "draw")
            throw std::runtime_error("hook lookup received the wrong arguments");
        effects.emplace_back("hookLookup");
        return {};
    }
}
'''

MAIN = r'''
#define CHECK(condition) do { if (!(condition)) { std::cerr << "failed " << __LINE__ << ": " << #condition << '\n'; return 1; } } while (false)
int main(int argc, char** argv) {
    CHECK(argc == 2);
    const std::string scenario = argv[1];
    const std::string officialHash = OFFICIAL_CLIENT_HASH();
    CHECK(!officialHash.empty());
    std::string suppliedHash = officialHash;
    hostHash = suppliedHash.c_str();
    bool accepted = false;
    std::string reason = "ABI mismatch";

    if (scenario == "match") {
        accepted = true;
    } else if (scenario == "commit") {
        suppliedHash[0] = suppliedHash[0] == '0' ? '1' : '0';
        hostHash = suppliedHash.c_str();
    } else if (scenario.starts_with("dependency:")) {
        const auto dependency = scenario.substr(std::string("dependency:").size());
        const auto position = suppliedHash.find("_" + dependency + "_");
        CHECK(position != std::string::npos);
        const auto version = position + dependency.size() + 2;
        suppliedHash[version] = suppliedHash[version] == '0' ? '1' : '0';
        hostHash = suppliedHash.c_str();
    } else if (scenario == "host-null") {
        hostHash = nullptr;
        reason = "ABI hash unavailable";
    } else if (scenario == "host-empty") {
        hostHash = "";
        reason = "ABI hash unavailable";
    } else if (scenario == "client-null" || scenario == "client-empty") {
#ifdef SUBSTITUTE_CLIENT_HASH
        suppliedClientHash = scenario == "client-null" ? nullptr : "";
        reason = "ABI hash unavailable";
#else
        CHECK(false);
#endif
    } else {
        CHECK(false);
    }

    const auto initialHandle = reinterpret_cast<HANDLE>(uintptr_t{0x111});
    expectedHandle = reinterpret_cast<HANDLE>(uintptr_t{0x222});
    PHANDLE = initialHandle;
    try {
        const auto description = PLUGIN_INIT(expectedHandle);
        CHECK(accepted);
        CHECK(PHANDLE == expectedHandle);
        CHECK(handleAtHash == initialHandle);
        CHECK((effects == std::vector<std::string>{"hostHash", "mediaMaskInit", "hookLookup"}));
        CHECK(description.name == "init boundary exercised");
    } catch (const std::runtime_error& error) {
        CHECK(!accepted);
        CHECK(std::string_view(error.what()).find(reason) != std::string_view::npos);
        CHECK(PHANDLE == initialHandle);
        CHECK(handleAtHash == initialHandle);
        CHECK((effects == std::vector<std::string>{"hostHash"}));
    }
}
'''


class PluginAbiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).parent
        source = (root / "plugin/main.cpp").read_text()
        signature = "APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {"
        start = source.index(signature)
        # Include the first actual hook lookup so accepted/rejected cases cover
        # handle publication, mask initialization and entry into the hook API.
        end = source.index("\n    void* drawAddr = nullptr;", start)
        prefix = source[start:end] + '\n    return {"init boundary exercised", "", "", ""};\n}\n'
        flags = shlex.split(subprocess.check_output(
            ["pkg-config", "--cflags", "hyprland"], text=True))
        header_path = next(
            Path(flag[2:]) / "src/plugins/PluginAPI.hpp"
            for flag in flags if flag.startswith("-I")
            and (Path(flag[2:]) / "src/plugins/PluginAPI.hpp").is_file())
        header = header_path.read_text()
        # The complete header also constructs Hyprland's global logger/color
        # state, whose implementation belongs to the live compositor. Check
        # compatibility with that real header without linking; execute using
        # its exact ABI declarations, hash implementation and version header.
        macros = "\n".join(
            re.search(r"^#define " + name + r"\s+[^\n]+", header, re.MULTILINE).group()
            for name in ("APICALL", "EXPORT", "HANDLE", "PLUGIN_INIT"))
        types = "\n".join(
            re.search(pattern, header, re.DOTALL).group()
            for pattern in (r"using PLUGIN_DESCRIPTION_INFO = struct \{.*?\};", r"struct SFunctionMatch \{.*?\};"))
        hash_start = re.search(
            r"^APICALL\s+EXPORT\s+const char\s*\*\s*__hyprland_api_get_hash\(\);",
            header, re.MULTILINE).start()
        hashes = header[hash_start:header.index("// NOLINTEND", hash_start)]
        minimal_header = ('#include <hyprland/src/version.h>\n#include <string>\n'
                          '#include <string_view>\n#include <vector>\n'
                          + macros + "\n" + types + "\n" + hashes)
        cls.directory = tempfile.TemporaryDirectory(prefix="brave-plugin-abi-")
        cls.executables = {}
        try:
            syntax = subprocess.run(
                ["g++", "-std=c++23", *flags, "-x", "c++", "-", "-fsyntax-only"],
                input=("#include <hyprland/src/plugins/PluginAPI.hpp>\n"
                       "#define OFFICIAL_CLIENT_HASH __hyprland_api_get_client_hash\n"
                       + COMMON + prefix + MAIN),
                text=True, capture_output=True, timeout=60)
            if syntax.returncode:
                raise AssertionError(syntax.stderr)
            for substitute in (False, True):
                headers = ""
                if substitute:
                    headers += "#define __hyprland_api_get_client_hash installed_client_hash\n"
                headers += minimal_header
                if substitute:
                    headers += "#undef __hyprland_api_get_client_hash\n"
                    headers += "#define SUBSTITUTE_CLIENT_HASH\n#define OFFICIAL_CLIENT_HASH installed_client_hash\n"
                    headers += '''
const char* suppliedClientHash = installed_client_hash();
APICALL EXPORT const char* __hyprland_api_get_client_hash() { return suppliedClientHash; }
'''
                else:
                    headers += "#define OFFICIAL_CLIENT_HASH __hyprland_api_get_client_hash\n"
                executable = str(Path(cls.directory.name) / ("missing-client" if substitute else "official-client"))
                result = subprocess.run(
                    ["g++", "-std=c++23", "-O1", *flags, "-x", "c++", "-", "-o", executable],
                    input=headers + COMMON + prefix + MAIN,
                    text=True, capture_output=True, timeout=60)
                if result.returncode:
                    raise AssertionError(result.stderr)
                cls.executables[substitute] = executable
        except BaseException:
            cls.directory.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def check_scenario(self, scenario, substitute=False):
        result = subprocess.run(
            [self.executables[substitute], scenario],
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_matching_official_hash_initializes_once_after_validation(self):
        self.check_scenario("match")

    def test_commit_mismatch_is_rejected_before_initialization(self):
        self.check_scenario("commit")

    def test_each_dependency_mismatch_is_rejected_before_initialization(self):
        for dependency in ("aq", "hu", "hg", "hc", "hlg"):
            with self.subTest(dependency=dependency):
                self.check_scenario("dependency:" + dependency)

    def test_missing_host_hash_is_rejected_before_initialization(self):
        for scenario in ("host-null", "host-empty"):
            with self.subTest(scenario=scenario):
                self.check_scenario(scenario)

    def test_missing_client_hash_is_rejected_before_initialization(self):
        for scenario in ("client-null", "client-empty"):
            with self.subTest(scenario=scenario):
                self.check_scenario(scenario, substitute=True)


if __name__ == "__main__":
    unittest.main()
