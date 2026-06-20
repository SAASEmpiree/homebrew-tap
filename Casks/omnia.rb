cask "omnia" do
  version "1.0.0"
  sha256 "b24b4e692c3b3021d2bb1e24c8a8717c0f54b875c7678af34a66e937e627e204"

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
