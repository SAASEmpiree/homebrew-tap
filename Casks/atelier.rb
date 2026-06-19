cask "atelier" do
  version "0.3.2"
  sha256 "9bfaa621e4b021f25987dceb26aee6bfa7437555241e67c1f756ad4ad206948b"

  url "https://github.com/SAASEmpiree/atelier-fichiers/releases/download/v#{version}/Atelier_#{version}_aarch64.dmg"
  name "Atelier"
  desc "Boîte à outils de fichiers locale (compression, conversion, PDF…)"
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
