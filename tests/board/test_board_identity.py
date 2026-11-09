"""Board identity parsed from collection paths; unknown must stay None."""

import pytest

from api.board.board_identity import is_global_number, normalize_board_number, parse_identity


@pytest.mark.parametrize(
    "path,number,brand,model",
    [
        (
            "Computers/1 Laptop/APPLE/A29xx/A2992 820-02918/A2992 820-02918-A.pcb",
            "820-02918",
            "Apple",
            "A2992",
        ),
        (
            "Computers/1 Laptop/APPLE/A14xx/A1418_820-3302 D7/Schematic.pdf",
            "820-3302",
            "Apple",
            "A1418",
        ),
        (
            "Phones/iPhone/iPhone13/x/iPhone13_BB-820-02404-08 PCB layer.pcb",
            "820-02404",
            "Apple",
            "iPhone13",
        ),
        (
            "Computers/1 Laptop/OEM factory/6 Compal new 1/LA/LAH792P-R20_MB.bdv",
            "LA-H792P",
            "Compal",
            None,
        ),
        ("Computers/1 Laptop/DELL/NEW DELL/LA-N805P/LA-N805P.cad", "LA-N805P", "Dell", None),
        (
            "Computers/1 Laptop/OEM factory/20 other/PCB/NMA044R05-1225-2RTE.pcb",
            "NM-A044",
            None,
            None,
        ),
        (
            "Computers/1 Laptop/Lenovo ThinkPad/IdeaPad series/320-15IKBRA/NSB241R10.tvw",
            "NS-B241",
            "Lenovo",
            "320-15IKBRA",
        ),
        ("Computers/1 Laptop/ACER/Unclassified/da0zrppc6c0-c-guo.pcb", "DA0ZRPPC6C0", "Acer", None),
        (
            "Computers/1 Laptop/HP/New HP/HP 830 G6 - CATALONI - 6050A3022401-MB-A01.pcb",
            "6050A3022401",
            "HP",
            None,
        ),
        (
            "Computers/1 Laptop/DELL/SCH/Dell M 48.4HH01.0SA schematics.pdf",
            "48.4HH01.0SA",
            "Dell",
            None,
        ),
        (
            "Computers/1 Laptop/DELL/SCH/Dell N5040 10263-1 48.4IP01.011 Rev A00.pdf",
            "10263-1",
            "Dell",
            None,
        ),
        ("Computers/1 Laptop/OEM factory/20 other/PCB/12088-1RTE.pcb", "12088-1", None, None),
        ("Computers/2 PC Motherboard/MSI/PCB/7C92_14.pcb", "MS-7C92", "MSI", None),
        (
            "Computers/2 PC Motherboard/MSI/PCB/MSI MAG B660M MS-7D42 Rev 1.1.cad",
            "MS-7D42",
            "MSI",
            None,
        ),
        ("Computers/3 Graphics card/1 MSI graphics card/V2xx/V258-1.0.cad", "MS-V258", "MSI", None),
        (
            "Computers/2 PC Motherboard/GIGABYTE/LGA 1150 series/87/GA-Z87X-D3H r1.01.tvw",
            "Z87X-D3H",
            "Gigabyte",
            "Z87X-D3H",
        ),
        (
            "Computers/2 PC Motherboard/GIGABYTE/LGA 1155 series/67/P67A-UD3P-11B.tvw",
            "P67A-UD3P",
            "Gigabyte",
            "P67A-UD3P",
        ),
        (
            "Computers/2 PC Motherboard/ASUS/boardview/P series/P8H61-M_PRO_1.01.fz",
            "P8H61-M-PRO",
            "ASUS",
            "P8H61-M-PRO",
        ),
        ("Computers/1 Laptop/ASUS/ASUS-FZ/FZ boardview1/G73_MB r1.0.fz", "G73", "ASUS", "G73"),
        (
            "Computers/2 PC Motherboard/ASRock/X99/X99 EXTREME6_R1.07(70-MXGT03-A01).fz",
            "X99-EXTREME6",
            "ASRock",
            "X99-EXTREME6",
        ),
        (
            "Phones/SAMSUNG/S series/S22 5G SM-S901/SM-S901U SUB PCB layer.pcb",
            "SM-S901U",
            "Samsung",
            "S22 5G SM-S901",
        ),
        (
            "Phones/HUAWEI/P Series/P50 Pro/P50 Pro-HN1JADEMA PCB layer.pcb",
            "HN1JADEMA",
            "Huawei",
            "P50 Pro",
        ),
        (
            "Phones/Motorola/Moto X series/Moto X40/Moto X40-SR28D54179 REV_A MB.pcb",
            "SR28D54179",
            "Motorola",
            "Moto X40",
        ),
        (
            "Phones/Vivo/X Series/X80 Pro/X80 Pro-ET3072AM MB PCB layer.pcb",
            "ET3072AM",
            "Vivo",
            "X80 Pro",
        ),
    ],
)
def test_parses_real_collection_shapes(path, number, brand, model):
    assert parse_identity(path) == {"board_number": number, "brand": brand, "model": model}


def test_folder_supplies_number_for_a_generic_file_name():
    identity = parse_identity("Computers/1 Laptop/DELL/Dell full set/13229-1_Latitude 3340/x.pdf")
    assert identity["board_number"] == "13229-1"
    assert identity["model"] == "Latitude 3340"


@pytest.mark.parametrize(
    "path",
    [
        "",
        "notes.pdf",
        "Phones/Other/中文测试.pdf",
        "Phones/iPhone/iPhone16Pro_ProMax/iPhone16Pro FaceID Flexible flat cable.pcb",
        "Computers/4 Monitor_TV/Common chips/common chip datasheet/LA-1234P.pdf",
        "Computers/1 Laptop/Samsung/Unsorted/winchester neutral_file.cad",
    ],
)
def test_unknown_board_number_stays_none(path):
    assert parse_identity(path)["board_number"] is None


def test_datasheet_trees_have_no_identity():
    assert parse_identity("Computers/4 Monitor_TV/Common chips/Richtek/RT8167B.pdf") == {
        "board_number": None,
        "brand": None,
        "model": None,
    }


def test_bare_file_name_keeps_self_identifying_numbers():
    assert parse_identity("A2159 820-01598 board.pcb") == {
        "board_number": "820-01598",
        "brand": "Apple",
        "model": "A2159",
    }
    # Brand-scoped rules need the folder: a bare MSI code is not recognised.
    assert parse_identity("7C92_14.pcb")["board_number"] is None


def test_folder_naming_two_brands_decides_nothing():
    path = "Computers/3 Graphics card/3 ASUS AsRock/Schematic and boardview/x.pcb"
    assert parse_identity(path)["brand"] is None


def test_phone_part_numbers_are_not_read_as_wistron():
    assert parse_identity("Phones/Motorola/Moto E6/Moto E6-88941-1 x.pcb")["board_number"] is None


def test_normalize_user_input():
    assert normalize_board_number(" lah792p ") == "LA-H792P"
    assert normalize_board_number("z87x-d3h") == "Z87X-D3H"


def test_global_numbers_exclude_vendor_names():
    assert is_global_number("820-02918")
    assert is_global_number("LA-H792P")
    assert not is_global_number("B450M-K")
