# Chan-M 静态画线数据目录

把 `backend/export_for_chanm.py` 导出的文件放到这里，文件名格式为：

    <code>_<period>.json

例如：

    sh588080_day.json
    sz000001_30m.json

这些文件随 `frontend/chan-m/` 一起推送到 Gitee Pages 后，手机端打开 Chan-M 并加载对应代码+周期时，会自动读取这里的预置画线数据。

## 导出命令示例

```bash
python backend/export_for_chanm.py backend/data/klinedev_v1_drawings_588080_1d.json sh588080
```

## 数据优先级

1. 若本地（localStorage）有更新调整，且保存时间晚于静态文件导出时间，则优先使用本地数据；
2. 否则自动使用本目录下的静态数据。
