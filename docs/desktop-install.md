# Weclio 桌面版安装说明

## 一、安装

1. 双击 `node-v26.13.0-x64.msi`，一路「下一步」装完。
2. 双击 `Weclio-<版本>-x64-Setup.exe`，装到默认目录。
3. 双击 `Git-2.56.1-64-bit.exe`，装到默认目录。
4. 双击 `导入模型和搜索配置.bat`，把模型和搜索配置装好。
5. 双击桌面上的 Weclio 图标打开，在「设置 → 模型」里选择要用的模型。

## 二、导入模型和搜索配置

双击 `导入模型和搜索配置.bat` 即可，它会把 `models.json` 和 `tavily.json` 放到 `C:/Users/<你的用户名>/.pi/agent/`。

- `models.json`：已配好的模型列表。
- `tavily.json`：网页搜索的 Tavily key；想换成自己的，用记事本改 `apiKey`（在 https://tavily.com 注册获取），保存后下一轮对话生效。
- 目录里已有同名文件时，脚本会先存成 `文件名.bak-时间`，不会直接覆盖丢失。

## 三、让 Agent 安装或更新扩展包

复制这句话给 Agent：

> 请帮我安装或更新 Weclio 的两个扩展包：从 npm 安装最新版 `@weclio/plugins` 和 `@weclio/tox`，并把它们注册到 Pi 用户配置里，保留其他设置。

安装成功后，在**当前对话**输入 `/reload`，不用重启 Weclio。以后更新时，把上面这句话再发一次即可。

## 四、可用技能

1. `tox-eval`：生成物质摘要。可直接说「使用 tox-eval 技能，写抗氧剂 168 的摘要，目标人群成人，骨植入，终生暴露，ISO 10993-17 标准」；或在对话框输入 `/` 选择该技能再提要求。
2. `tra-md`：完整的医疗器械毒理学风险评估（TRA）。
3. `tra-md2word`：把 final 版报告转换为 Word。
4. `read-across`：生成 read-across 论据（仍在改进中）。
5. `docx`：修改编辑 Word。

## 五、出问题时

把问题描述和截图发到 ivanjin@weclio.com，并说明预期结果与实际结果。
