class Tricot < Formula
  desc "Shared planning board where humans and agents make decisions together"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.1.5/tricot-0.1.5.tgz"
  sha256 "af1581b0fc1d8c31e8d7043891c29feb8cbb07d8643614c6a226edbe61f26832"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  bottle do
    root_url "https://github.com/TricotStudio/tricot/releases/download/v0.1.5"
    sha256 cellar: :any_skip_relocation, all: "8b87478caf1672b489587ed600e957c60f91656b25ba456cf7ef92d63a83572f"
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
