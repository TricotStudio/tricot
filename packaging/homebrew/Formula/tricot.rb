# sha256 of a local npm pack (tricot-0.1.0.tgz), not of the published tarball:
# run scripts/homebrew-formula.mjs again once tricot 0.1.0 is on npm.
class Tricot < Formula
  desc "Shared planning board where humans and agents make decisions together"
  homepage "https://tricotstudio.com"
  url "https://registry.npmjs.org/tricot/-/tricot-0.1.0.tgz"
  sha256 "e6f5b6020d202fe161e75bf3e60437f24f03d56ca98d82f870c9e4b5cb19df76"
  license "AGPL-3.0-only"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "--data", testpath/"boards"
    begin
      info = shell_output("curl --silent --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:#{port}/api/info")
      assert_equal "tricot", JSON.parse(info)["app"]
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
