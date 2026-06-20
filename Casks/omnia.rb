cask "omnia" do
  version "1.0.0"
  sha256 "19e58b6cf86894631effd87e066e0c2cd0eb3bfd76412e991265b4d9f77fd175"

  url "https://github.com/SAASEmpiree/omnia/releases/download/v#{version}/Omnia_#{version}_aarch64.dmg"
  name "Omnia"
  desc "Boîte à outils de fichiers 100 % locale (conversion, compression, PDF, audio/vidéo, confidentialité)"
  homepage "https://github.com/SAASEmpiree/omnia"

  depends_on arch: :arm64

  app "Omnia.app"

  caveats <<~EOS
    Omnia n'est pas encore signée par Apple. Si macOS bloque le 1er lancement :
      • clic droit sur Omnia dans Applications → « Ouvrir » (une seule fois),
      • ou : xattr -dr com.apple.quarantine /Applications/Omnia.app

    Outils audio/vidéo et conversion de documents : installer ffmpeg et LibreOffice
    (facultatifs) sur le système.
  EOS

  zap trash: [
    "~/Library/Application Support/com.saasempiree.omnia",
    "~/Library/Caches/com.saasempiree.omnia",
    "~/Library/WebKit/com.saasempiree.omnia",
  ]
end
