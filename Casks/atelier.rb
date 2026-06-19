cask "atelier" do
  version "0.3.4"
  sha256 "f37e9fb5893f3c5d7fe0411cf58ea515593d6496bbeb9e815c97286b83c72163"

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
