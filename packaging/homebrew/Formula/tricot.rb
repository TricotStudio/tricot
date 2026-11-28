class Tricot < Formula
  desc "Shared board of canvases and threads for humans and agents"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.0.7/tricot-0.0.7.tgz"
  sha256 "9164c76e5729970940727e575f1e2660087a7f7da8e82a0eb6b7f0073bc4b5f0"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  bottle do
    root_url "https://github.com/TricotStudio/tricot/releases/download/v0.0.7"
    sha256 cellar: :any_skip_relocation, all: "723aaf4200866b6709e13d67c33a3b6befc3a1d128620a79a3c9d2ff448a2917"
  end

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "--no-ask", "--no-update-check",
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
