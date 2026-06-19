cask "atelier" do
  version "0.1.0"
  sha256 "a195988598e98702107715f20973befeb95701dd7b5e4d8024bcb9b7948d3caa"

  url "https://github.com/SAASEmpiree/atelier-fichiers/releases/download/v#{version}/Atelier_#{version}_aarch64.dmg"
  name "Atelier"
  desc "Boîte à outils de fichiers 100 % locale (compression, conversion, PDF…)"
  homepage "https://github.com/SAASEmpiree/atelier-fichiers"

  depends_on arch: :arm64

  app "Atelier.app"

  # L'app n'est pas encore signée : on retire la quarantaine après installation
  # pour éviter le blocage Gatekeeper (sinon clic droit → Ouvrir serait requis).
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Atelier.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.saasempiree.atelier",
    "~/Library/Caches/com.saasempiree.atelier",
    "~/Library/WebKit/com.saasempiree.atelier",
  ]
end
