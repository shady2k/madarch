# The Homebrew formula of the madarch release binary (madarch-lfhu).
#
# Install from the maintained tap:
#
#   brew install shady2k/tap/madarch
#
# (or install straight from any tap that carries this file). The formula
# installs the release binary only: no build steps, no dependencies; the
# wiki app rides inside the binary, and every release carries the SHA256
# sums the formula checks.
class Madarch < Formula
  desc "The madarch command as one release binary: products, wiki, upgrade"
  homepage "https://github.com/shady2k/madarch"
  version "0.1.0"

  if OS.mac? && Hardware::CPU.arm?
    @artifact = "madarch-darwin-arm64"
    sha256sum = "RELEASE_SHA256_DARWIN_ARM64"
  elsif OS.mac?
    @artifact = "madarch-darwin-x64"
    sha256sum = "RELEASE_SHA256_DARWIN_X64"
  elsif Hardware::CPU.arm?
    @artifact = "madarch-linux-arm64"
    sha256sum = "RELEASE_SHA256_LINUX_ARM64"
  else
    @artifact = "madarch-linux-x64"
    sha256sum = "RELEASE_SHA256_LINUX_X64"
  end

  url "https://github.com/shady2k/madarch/releases/download/v#{version}/#{@artifact}"
  sha256 sha256sum

  # Linux LadybugDB links against OpenSSL 3. Homebrew supplies it and the
  # launcher exposes its keg library directory to the binary.
  depends_on "openssl@3" => :linux

  def install
    libexec.install @artifact => "madarch-bin"
    (libexec / "madarch-bin").chmod 0755
    if OS.linux?
      (bin / "madarch").write_env_script libexec / "madarch-bin",
        LD_LIBRARY_PATH: "#{Formula["openssl@3"].opt_lib}:#{ENV["LD_LIBRARY_PATH"]}"
    else
      (bin / "madarch").write_exec_script libexec / "madarch-bin"
    end
  end

  test do
    # The release build smoke runs new, opens the graph store and serves it;
    # this formula test confirms the installed executable answers as built.
    assert_equal "version: #{version}", pipe_output("#{bin}/madarch version 2>&1").strip
  end
end
