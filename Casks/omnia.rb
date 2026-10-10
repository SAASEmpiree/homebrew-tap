# Omnia 1.0.0 (Tauri DMG, mirrored from the v1.0.0 build). The next tools/ship release regenerates this file.
cask "omnia" do
  version "1.0.0"
  sha256 "51cb2e63159e666c5f29af9cc241977a42a5bcf744b44665209ac439060a96a1"

  url "https://github.com/SAASEmpiree/homebrew-tap/releases/download/omnia-v#{version}/Omnia_#{version}_aarch64.dmg"
  name "Omnia"
  desc "Convert, compress, merge and clean files 100% on your Mac, with zero network"
  homepage "https://github.com/SAASEmpiree/homebrew-tap#omnia"

  depends_on arch: :arm64

  app "Omnia.app"

  zap trash: [
    "~/Library/Application Support/com.saasempiree.omnia",
    "~/Library/Caches/com.saasempiree.omnia",
    "~/Library/HTTPStorages/com.saasempiree.omnia",
    "~/Library/Preferences/com.saasempiree.omnia.plist",
    "~/Library/Saved Application State/com.saasempiree.omnia.savedState",
    "~/Library/WebKit/com.saasempiree.omnia",
  ]

  caveats <<~EOS
    Audio/video tools and document conversion use ffmpeg and LibreOffice when installed (optional).

    Omnia is signed with the SAASEmpiree self-signed certificate, not notarized by Apple.
    If macOS refuses to open it the first time, run once:
      xattr -dr com.apple.quarantine "#{appdir}/Omnia.app"
  EOS
end
