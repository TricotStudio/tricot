class Tricot < Formula
  desc "Shared planning board where humans and agents make decisions together"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.1.6/tricot-0.1.6.tgz"
  sha256 "2864b4378484f8e259ae4707bc3331e258acaeb992a62bb30ff0b285a78f8d83"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  bottle do
    root_url "https://github.com/TricotStudio/tricot/releases/download/v0.1.6"
    sha256 cellar: :any_skip_relocation, all: "769fe7265456eb7c5b98034e0a32170845fdc9c4e53e9f45eab2c780616ae1ef"
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
