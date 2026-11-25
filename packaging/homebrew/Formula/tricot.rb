class Tricot < Formula
  desc "Shared board of canvases and threads for humans and agents"
  homepage "https://tricotstudio.com"
  url "https://github.com/TricotStudio/tricot/releases/download/v0.0.6/tricot-0.0.6.tgz"
  sha256 "d9937156df9292e31013d185cac3156fd8a65771453eb013afb8d50d0809e899"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  bottle do
    root_url "https://github.com/TricotStudio/tricot/releases/download/v0.0.6"
    sha256 cellar: :any_skip_relocation, all: "e660ddff9d304d2e0778f1d7548fd6eca288bf04a94020c6ef21b9121698bef7"
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
