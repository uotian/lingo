開発者とGitHub Actionsが同じpnpm checkを使う。実行順は文書、未使用コード、書式、型、単体テスト、配布ファイルの作成。pnpm test:e2eは別に呼び出し、Chromeと疑似APIで拡張を検証する。
