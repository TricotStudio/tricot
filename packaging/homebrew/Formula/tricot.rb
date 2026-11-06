class Tricot < Formula
  desc "Shared planning board where humans and agents make decisions together"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.1.4/tricot-0.1.4.tgz"
  sha256 "d3102e12a5e9d7a6efb71f01cfb38dc990ac7c6e698190f2941553d4aae1284d"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  bottle do
    root_url "https://github.com/TricotStudio/tricot/releases/download/v0.1.4"
    sha256 cellar: :any_skip_relocation, all: "50613b0826964655cf1c7b85ed7d64892a173bb7549707efbde7544be4dd4d53"
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
