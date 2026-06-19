cask "atelier" do
  version "0.2.0"
  sha256 "a30dc66a0c8440d9366d1cc2d1594b1557570becb3c8a6a6de868524d41a64ac"

  url "https://github.com/SAASEmpiree/atelier-fichiers/releases/download/v#{version}/Atelier_#{version}_aarch64.dmg"
  name "Atelier"
  desc "Boîte à outils de fichiers 100 % locale (compression, conversion, PDF…)"
  homepage "https://github.com/SAASEmpiree/atelier-fichiers"

  depends_on arch: :arm64

  app "Atelier.app"

  caveats <<~EOS
    Atelier n'est pas encore signée par Apple. Si macOS bloque le 1er lancement :
      • clic droit sur Atelier dans Applications → « Ouvrir » (une seule fois),
      • ou : xattr -dr com.apple.quarantine /Applications/Atelier.app
  EOS

  zap trash: [
    "~/Library/Application Support/com.saasempiree.atelier",
    "~/Library/Caches/com.saasempiree.atelier",
    "~/Library/WebKit/com.saasempiree.atelier",
  ]
end
