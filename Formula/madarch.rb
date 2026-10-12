# The Homebrew formula of the madarch release binary (madarch-lfhu).
#
# The tap holds it: clone a `homebrew-madarch` repository of your own and
# copy the file under `Formula/`, then
#
#   brew install shady2k/madarch/madarch
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
    artifact = "madarch-darwin-arm64"
    sha256sum = "RELEASE_SHA256_DARWIN_ARM64"
  elsif OS.mac?
    artifact = "madarch-darwin-x64"
    sha256sum = "RELEASE_SHA256_DARWIN_X64"
  elsif Hardware::CPU.arm?
    artifact = "madarch-linux-arm64"
    sha256sum = "RELEASE_SHA256_LINUX_ARM64"
  else
    artifact = "madarch-linux-x64"
    sha256sum = "RELEASE_SHA256_LINUX_X64"
  end

  url "https://github.com/shady2k/madarch/releases/download/v#{version}/#{artifact}"
  sha256 sha256sum

  # One binary, nothing else to lay: the wiki app rides inside it, and the
  # release's SHA256 sums are checked by brew when it downloads.
  def install
    bin.install artifact
  end

  test do
    # the installed binary answers the release version, no bun/node needed
    assert_equal "version: #{version}", pipe_output("#{bin}/madarch version 2>&1").strip
  end
end
