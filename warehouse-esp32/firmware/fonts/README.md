# 扫码枪显示字库

`terminal-font.dat` 是固件使用的抗锯齿字形数据。它基于 [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)，使用随附的 [SIL OFL 1.1](OFL.txt)。正文为 16 像素、700 字重，库存和数量使用独立的 20 和 26 像素数字字形。

源文件来自 [Google Fonts](https://github.com/google/fonts/blob/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf)，SHA-256 为 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`。

日常编译直接使用已生成的文件。需要换字重或尺寸时，在装有 Pillow 和 fontTools 的环境运行以下命令。

```sh
python3 fonts/build_font.py /path/to/NotoSansSC.ttf
```
