"""Install the small English model packaged with the hosted demo."""
from hashlib import file_digest
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

MODEL_NAME = "vosk-model-small-en-us-0.15"
MODEL_DIR = Path(__file__).resolve().parents[1] / ".models" / MODEL_NAME
EXPECTED_SHA256 = "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498"


def download_model():
    if MODEL_DIR.joinpath("am", "final.mdl").is_file():
        return
    MODEL_DIR.parent.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=MODEL_DIR.parent) as folder:
        temporary = Path(folder)
        archive = temporary / f"{MODEL_NAME}.zip"
        with urlopen(f"https://alphacephei.com/vosk/models/{archive.name}", timeout=15) as source, archive.open("wb") as target:
            copyfileobj(source, target)
        with archive.open("rb") as handle:
            if file_digest(handle, "sha256").hexdigest() != EXPECTED_SHA256:
                raise RuntimeError("Hosted speech model checksum did not match.")
        with ZipFile(archive) as model:
            model.extractall(temporary)
        temporary.joinpath(MODEL_NAME).replace(MODEL_DIR)
    print(f"Packaged hosted speech model: {MODEL_NAME}")


if __name__ == "__main__":
    download_model()
