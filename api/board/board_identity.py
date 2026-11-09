"""Board identity from a catalog path: board number, brand and model.

Pure and dependency-free. Heuristics only read the file name and its folders,
and only recognise shapes observed in the collection. Anything else stays None:
a wrong board number links the wrong schematic, which is worse than no link.
"""

from __future__ import annotations

import re

_START = r"(?<![0-9A-Z])"
_END = r"(?![0-9A-Z])"
# Compal-style numbers run straight into a revision ("LAG711PR10-1109RTE").
_REVISION_TAIL = r"(?=R\d|[^0-9A-Z]|$)"

# (pattern, canonical form). Text is upper-cased first; the order is the
# priority when one name carries several numbers.
_UNIVERSAL: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(_START + r"820-(\d{4,5})" + _END), r"820-\1"),
    (re.compile(_START + r"LA-?([0-9A-Z]\d{3})P" + _REVISION_TAIL), r"LA-\1P"),
    (re.compile(_START + r"LS-?([0-9A-Z]\d{3})P" + _REVISION_TAIL), r"LS-\1P"),
    (re.compile(_START + r"NM-?([A-Z]\d{3,4})" + _REVISION_TAIL), r"NM-\1"),
    (re.compile(_START + r"NS-?([A-Z]\d{3})" + _REVISION_TAIL), r"NS-\1"),
    (re.compile(_START + r"(DA[0-9A-Z]{3,6}(?:MB|PC|PI|PD|PJ|YB)[0-9A-Z]{2,4})" + _END), r"\1"),
    (re.compile(_START + r"(6050A\d{7})" + _END), r"\1"),
)
_WISTRON = re.compile(_START + r"(?:([01]\d[0-9A-Z]\d{2})|(2\d{5}))-(\d|S[A-Z])M?(?:RTE)?" + _END)
_WISTRON_48 = re.compile(_START + r"(48\.[0-9A-Z]{5}\.[0-9A-Z]{3})" + _END)
_LATE: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(_START + r"(BA41-\d{5}[A-Z]?)" + _END), r"\1"),
    (re.compile(_START + r"MS-([0-9A-Z]{4,5})" + _END), r"MS-\1"),
    (re.compile(_START + r"(SM-[A-Z]\d{3}[A-Z0-9]{0,3})" + _END), r"\1"),
    (re.compile(_START + r"((?:HL|HN|SH)\d[A-Z]{4,12}\d{0,3}[A-Z]?)" + _END), r"\1"),
    (re.compile(_START + r"(SR28[A-Z]\d{5})" + _END), r"\1"),
    (re.compile(_START + r"((?:HAC|HDH|HEG|HAD|BEE)-CPU-\d{2}|(?:EDM|BDM)-\d{3})" + _END), r"\1"),
    (re.compile(_START + r"(NB\d{4})(?=[_-])"), r"\1"),
)
# Vendor board codes whose shape is only unambiguous inside the phone tree.
_PHONE: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(_START + r"((?:ET|PD)\d{4}[0-9A-Z]{0,6})" + _END), r"\1"),
    (re.compile(_START + r"(?=\d*[A-Z])(1?35[0-9A-Z]{5,9})" + _END), r"\1"),
    (re.compile(_START + r"(2[A-Z]{2}\d{3})(?:-\d)?" + _END), r"\1"),
)

_APPLE_MODEL = re.compile(_START + r"(A\d{4})" + _END)
_MSI_BARE = re.compile(r"^(?:MS-?)?(\d[0-9A-Z]{3,4}|[VN]\d{3,4})(?=V\d|[-_ (]|$)")
_ASUS_PART = re.compile(_START + r"((?:59|60|69|70|80)-?[0-9A-Z]{6,12})" + _END)
_VENDOR_REVISION = re.compile(
    r"[ _-]+(?:REV\.?\s*|R|V)?\d\.\d{1,2}[A-Z]{0,2}(?![0-9])|[ _-]+R\d{3}[A-Z]?$|[-_]\d{3}[A-Z]?$"
)
_GIGABYTE_SHORT_REVISION = re.compile(r"[-_]\d{2}[A-Z]?$")
_VENDOR_CODE = re.compile(r"^[A-Z]{1,4}\d{2,4}[A-Z]{0,4}(?:-[A-Z0-9]{1,5})?$")
_VENDOR_HEAD = re.compile(r"^[0-9A-Z+][0-9A-Z+ _.-]*$")
_VENDOR_NOISE = re.compile(r"(?:[ _-]+(?:MB|MAIN|BOARD|PCB))+$")
_VENDOR_PREFIX = re.compile(r"^(?:ASUS|ASROCK|GIGABYTE)[ _-]+")

# Folders that describe the collection's filing, not a device.
_FILING_FOLDER = re.compile(
    r"schematic|boardview|board view|bitmap|\bsch\b|\bpcb\b|\bview\b|diode|maintenance|repair"
    r"|tutorial|guide|series|unorganized|uncluttered|unclassified|\bnew\b|\bold\b|chinafix"
    r"|\bother\b|\bfree trial\b|location|\bfz\b|\bbios\b|xx\b|~|^\d+$|^\d{1,4}[ .]",
    re.IGNORECASE,
)
_CLEAN_MODEL = re.compile(
    r"(?:(?<![0-9A-Za-z])820-\d{4,5}\S*)|(?:(?<![0-9])[01]\d{4}-\d[A-Za-z]?_?)"
)
_NON_BOARD_FOLDER = re.compile(r"common chips|datasheet", re.IGNORECASE)

# Folder word -> canonical brand. A folder naming two brands decides nothing.
_BRANDS: tuple[tuple[str, str], ...] = (
    ("apple|iphone|ipad|macbook", "Apple"),
    ("lenovo|thinkpad", "Lenovo"),
    ("asus|华硕", "ASUS"),
    ("asrock", "ASRock"),
    ("gigabyte", "Gigabyte"),
    ("msi", "MSI"),
    ("dell", "Dell"),
    ("hp", "HP"),
    ("acer", "Acer"),
    ("samsung", "Samsung"),
    ("huawei", "Huawei"),
    ("honor", "Honor"),
    ("xiaomi", "Xiaomi"),
    ("redmi", "Redmi"),
    ("oppo", "OPPO"),
    ("vivo", "Vivo"),
    ("realme", "Realme"),
    ("oneplus", "OnePlus"),
    ("motorola", "Motorola"),
    ("meizu", "Meizu"),
    ("nubia", "Nubia"),
    ("tecno", "Tecno"),
    ("infinix", "Infinix"),
    ("google", "Google"),
    ("nokia", "Nokia"),
    ("lg", "LG"),
    ("sharp", "Sharp"),
    ("gionee", "Gionee"),
    ("mechrevo", "Mechrevo"),
    ("surface|xbox|microsoft", "Microsoft"),
    ("sony", "Sony"),
    ("nintendo", "Nintendo"),
    ("steam deck", "Valve"),
    ("galaxy", "Galaxy"),
    ("quanta", "Quanta"),
    ("compal", "Compal"),
    ("wistron", "Wistron"),
    ("inventec", "Inventec"),
)
_BRAND_PATTERNS = tuple(
    (re.compile(r"(?<![0-9a-z])(?:" + words + r")(?![a-z])", re.IGNORECASE), brand)
    for words, brand in _BRANDS
)
_FAMILY_BRAND = (("820-", "Apple"), ("SM-", "Samsung"), ("MS-", "MSI"))
_GLOBAL_NUMBER = re.compile(
    r"820-\d+|L[AS]-\w+|N[MS]-\w+|DA\w{8,12}|6050A\d+|[012]\w{4,5}-\w+|48\.\S+|BA41-\S+|MS-\w+"
    r"|SM-\w+|(?:HL|HN|SH)\d\w+|SR28\w+|\w{3}-CPU-\d+|[EB]DM-\d+|NB\d{4}|(?:ET|PD)\d{4}\w*|1?35\w+|2[A-Z]{2}\d{3}"
)


def _detect_brand(text: str) -> str | None:
    found = {brand for pattern, brand in _BRAND_PATTERNS if pattern.search(text)}
    return found.pop() if len(found) == 1 else None


def _brand(folders: list[str], stem: str) -> tuple[str | None, int]:
    """Return the brand and the index of the first folder after the one naming it."""
    for index, folder in enumerate(folders):
        if brand := _detect_brand(folder):
            return brand, index + 1
    return _detect_brand(stem), 0


def _universal_number(text: str, top_level: str) -> str | None:
    for pattern, canonical in _UNIVERSAL:
        if match := pattern.search(text):
            return match.expand(canonical)
    # Five-digit Wistron numbers look like Motorola/phone part numbers elsewhere.
    if top_level != "PHONES" and (match := _WISTRON.search(text)):
        return f"{match[1] or match[2]}-{match[3]}"
    if match := _WISTRON_48.search(text):
        return match[1]
    late = _LATE + _PHONE if top_level == "PHONES" else _LATE
    for pattern, canonical in late:
        if match := pattern.search(text):
            return match.expand(canonical)
    return None


def _vendor_name(text: str, *, brand: str | None, need_revision: bool) -> str | None:
    """Canonical ASUS/ASRock/Gigabyte board name, without its revision."""
    text = _VENDOR_PREFIX.sub("", text)
    revision = _VENDOR_REVISION.search(text)
    if revision is None and (brand == "Gigabyte" or text.startswith(("GA-", "GV-"))):
        revision = _GIGABYTE_SHORT_REVISION.search(text)
    if revision is None:
        if need_revision:
            return None
        head = re.split(r"[ _(]", text, maxsplit=1)[0]
        return head if _VENDOR_CODE.fullmatch(head) else None
    head = _VENDOR_NOISE.sub("", text[: revision.start()]).strip(" _-.")
    if head.startswith("GA-"):
        head = head[3:]
    name = re.sub(r"[ _]+", "-", head)
    words = name.split("-")
    if (
        not _VENDOR_HEAD.fullmatch(head)
        or not 3 <= len(name) <= 40
        or len(words) > 7
        or not any(character.isdigit() for character in name)
        or not any(character.isalpha() for character in name)
    ):
        return None
    return name


def _number_in(
    text: str, *, brand: str | None, is_file: bool, top_level: str
) -> tuple[str | None, str | None]:
    """Return (board_number, model) found in one upper-cased path segment."""
    if brand != "MSI" and (number := _universal_number(text, top_level)):
        return number, None
    if brand == "MSI":
        for pattern, canonical in _LATE:
            if canonical.startswith("MS-") and (match := pattern.search(text)):
                return match.expand(canonical), None
        if is_file and (match := _MSI_BARE.match(text)):
            return f"MS-{match[1]}", None
        return _universal_number(text, "PHONES"), None
    if brand in {"ASUS", "ASRock", "Gigabyte"} or text.startswith(("GA-", "GV-")):
        if name := _vendor_name(text, brand=brand, need_revision=not is_file):
            return name, name
        if is_file and brand in {"ASUS", "ASRock"} and (match := _ASUS_PART.search(text)):
            return match[1], None
    return None, None


def _folder_model(folders: list[str], board_number: str | None) -> str | None:
    for folder in reversed(folders):
        if _FILING_FOLDER.search(folder) or not any(c.isdigit() for c in folder):
            continue
        cleaned = folder
        if board_number:
            cleaned = re.sub(re.escape(board_number), "", cleaned, flags=re.IGNORECASE)
        cleaned = _CLEAN_MODEL.sub("", cleaned).strip(" _-")
        if cleaned and any(c.isalnum() for c in cleaned):
            return cleaned
    return None


def parse_identity(relative_path: str) -> dict[str, str | None]:
    """Parse {board_number, brand, model} from a path relative to the collection.

    Works on a bare file name too; brand-scoped rules then simply do not apply.
    """
    empty: dict[str, str | None] = {"board_number": None, "brand": None, "model": None}
    parts = [part for part in relative_path.replace("\\", "/").split("/") if part]
    if not parts:
        return empty
    *folders, name = parts
    if any(_NON_BOARD_FOLDER.search(folder) for folder in folders):
        return empty
    stem = re.sub(r"\.[0-9A-Za-z_-]{1,10}$", "", name)
    brand, first_device_folder = _brand(folders, stem)
    top_level = folders[0].upper() if folders else ""

    board_number, model = None, None
    for segment, is_file in [(stem, True), *((folder, False) for folder in reversed(folders))]:
        board_number, model = _number_in(
            segment.upper(), brand=brand, is_file=is_file, top_level=top_level
        )
        if board_number:
            break
    if board_number and brand is None:
        brand = next((b for prefix, b in _FAMILY_BRAND if board_number.startswith(prefix)), None)
    if board_number and brand is None and stem.upper().startswith(("GA-", "GV-")):
        brand = "Gigabyte"

    if brand == "Apple":
        for segment in (stem, *reversed(folders)):
            if match := _APPLE_MODEL.search(segment.upper()):
                model = match[1]
                break
    # GIGABYTE and ASRock file motherboards under chipset folders ("P55", "Z370").
    chipset_folders = brand in {"Gigabyte", "ASRock"} and "Motherboard" in relative_path
    if model is None and not chipset_folders:
        model = _folder_model(folders[first_device_folder:], board_number)
    return {"board_number": board_number, "brand": brand, "model": model}


def normalize_board_number(value: str) -> str:
    """Canonical form of a user-typed board number, for exact lookups."""
    text = value.strip().upper()
    return _universal_number(text, "") or text


def is_global_number(board_number: str) -> bool:
    """True for manufacturer numbers that mean the same board across brands.

    Vendor names ("B450M-K") are reused by different manufacturers, so a match
    on one of those is only trustworthy within a single brand.
    """
    return _GLOBAL_NUMBER.fullmatch(board_number) is not None
