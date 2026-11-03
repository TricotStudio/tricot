class Tricot < Formula
  desc "Shared planning board where humans and agents make decisions together"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.1.0/tricot-0.1.0.tgz"
  sha256 "5384704cddc960941ed142bf0b152ddda810d44d7204f1bf856187e0c05fcbf3"
  license "AGPL-3.0-only"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "--no-hooks", "--no-update-check",
                "--data", testpath/"boards"
    begin
      info = shell_output("curl --silent --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:#{port}/api/info")
      assert_equal "tricot", JSON.parse(info)["app"]
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
