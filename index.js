const WebSocket = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');
const crypto = require('crypto');
require('dotenv').config();

// 設定を.envから読み込み
const CONFIG = {
    websocket: {
        port: parseInt(process.env.WEBSOCKET_PORT) || 25525,
    },
    discord: {
        token: process.env.DISCORD_TOKEN,
        channelId: process.env.DISCORD_CHANNEL_ID,
    },
    debug: process.env.DEBUG_MODE === 'true'
};

// 設定の検証
if (!CONFIG.discord.token || !CONFIG.discord.channelId) {
    console.error('必要な環境変数が設定されていません。');
    console.error('DISCORD_TOKEN と DISCORD_CHANNEL_ID を.envファイルで設定してください。');
    process.exit(1);
}

class MinecraftDiscordBridge {
    constructor() {
        this.wss = null;
        this.minecraftWs = null;
        this.discordClient = null;
        this.messageCount = 0;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000; // 5 seconds
        this.isConnecting = false;
        this.isReconnecting = false;
        this.currentServer = null;
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] ${message}`);
    }

    // Discordクライアントの初期化
    async initDiscord() {
        this.discordClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
        });

        this.discordClient.once('ready', () => {
            this.log(`Discord bot logged in as ${this.discordClient.user.tag}`);
        });

        this.discordClient.on('error', (error) => {
            this.log(`Discord error: ${error}`, 'ERROR');
        });

        await this.discordClient.login(CONFIG.discord.token);
    }

    // WebSocketサーバーの初期化
    async initWebSocketServer() {
        // 既存のサーバーがある場合は先にクローズ
        if (this.currentServer) {
            await new Promise(resolve => {
                this.currentServer.close(() => {
                    this.log('既存のWebSocketサーバーをクローズしました', 'INFO');
                    resolve();
                });
            });
            this.currentServer = null;
        }

        try {
            this.wss = new WebSocket.Server({ 
                port: CONFIG.websocket.port,
                host: '0.0.0.0'
            });
            this.currentServer = this.wss;

            this.log(`WebSocketサーバーがポート ${CONFIG.websocket.port} で待機中...`);
            this.log(`Minecraftから以下のコマンドで接続してください:`);
            this.log(`/connect localhost:${CONFIG.websocket.port}`);
            this.log(`または /wsserver localhost:${CONFIG.websocket.port}`);

            this.wss.on('connection', (ws, req) => {
                this.log(`Minecraftから接続されました: ${req.socket.remoteAddress}`);
                this.minecraftWs = ws;

                // Send connection message with system flag
                this.sendToDiscord('🟢 Minecraftサーバーが接続されました', true);

                ws.on('message', (data) => {
                    this.messageCount++;
                    this.log(`受信メッセージ #${this.messageCount}: ${data.length} bytes`, 'DEBUG');
                    
                    if (CONFIG.debug) {
                        this.log(`RAW DATA: ${data.toString()}`, 'DEBUG');
                    }

                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMinecraftMessage(message);
                    } catch (error) {
                        this.log(`JSON解析エラー: ${error.message}`, 'ERROR');
                        this.log(`受信データ: ${data.toString()}`, 'ERROR');
                        
                        // JSONではない場合、プレーンテキストとして処理
                        this.handlePlainTextMessage(data.toString());
                    }
                });

                // Add error handling for invalid frames
                ws._socket.on('error', (error) => {
                    if (error.message.includes('invalid status code')) {
                        this.log('Invalid WebSocket frame received, attempting to recover...', 'WARN');
                        ws.terminate(); // Force close the connection
                        this.reconnectMinecraft();
                    }
                });

                ws.on('close', (code, reason) => {
                    this.log(`Minecraft接続が閉じられました - Code: ${code}, Reason: ${reason}`);
                    this.minecraftWs = null;
                    this.sendToDiscord('🔴 Minecraftサーバーとの接続が切断されました');
                    
                    // Attempt to reconnect on unexpected closure
                    if (code === 1006) {
                        this.log('Unexpected disconnection, attempting to reconnect...', 'WARN');
                        this.reconnectMinecraft();
                    }
                });

                ws.on('error', (error) => {
                    this.log(`WebSocketエラー: ${error}`, 'ERROR');
                });

                // 接続後にイベント購読を試行
                setTimeout(() => {
                    this.subscribeToEvents();
                }, 1000);
            });

            this.wss.on('error', (error) => {
                this.log(`WebSocketサーバーエラー: ${error}`, 'ERROR');
            });
        } catch (error) {
            if (error.code === 'EADDRINUSE') {
                this.log('ポートが既に使用中です。サーバーを再起動します...', 'WARN');
                // プロセスを終了して再起動（PM2などの使用を想定）
                process.exit(1);
            }
            throw error;
        }
    }

    // プレーンテキストメッセージの処理
    handlePlainTextMessage(text) {
        this.log(`プレーンテキスト受信: ${text}`, 'DEBUG');
        
        // 一般的なチャット形式をパース
        const chatPatterns = [
            /^<(.+?)> (.+)$/, // <PlayerName> message
            /^\[(.+?)\] (.+)$/, // [PlayerName] message
            /^(.+?): (.+)$/, // PlayerName: message
            /^(.+?) says: (.+)$/, // PlayerName says: message
        ];

        for (const pattern of chatPatterns) {
            const match = text.match(pattern);
            if (match) {
                const playerName = match[1];
                const message = match[2];
                this.log(`チャットパターンマッチ: ${playerName} -> ${message}`, 'DEBUG');
                this.sendToDiscord(playerName, message);
                return;
            }
        }

        // パターンにマッチしない場合は、システムメッセージとして処理
        this.sendToDiscord('Minecraft', text);
    }

    // イベントリスナーの登録
    subscribeToEvents() {
        if (!this.minecraftWs || this.minecraftWs.readyState !== WebSocket.OPEN) {
            this.log('WebSocket接続が利用できません', 'ERROR');
            return;
        }

        this.log('イベント購読を開始します...');

        // 複数のイベントタイプを試行
        const events = [
            'PlayerMessage',
            'PlayerChat', 
            'ChatMessage',
            'PlayerJoin',
            'PlayerLeave',
            'PlayerConnect',
            'PlayerDisconnect'
        ];

        events.forEach(eventName => {
            const subscribeCommand = {
                header: {
                    requestId: this.generateUUID(),
                    messagePurpose: "subscribe",
                    version: 1,
                    messageType: "commandRequest"
                },
                body: {
                    eventName: eventName
                }
            };

            this.sendToMinecraft(subscribeCommand);
            this.log(`${eventName}イベントの購読を試行`, 'DEBUG');
        });

        // 代替方法: コマンドでチャットログを取得
        setTimeout(() => {
            this.tryAlternativeMethods();
        }, 2000);
    }

    // 代替方法を試行
    tryAlternativeMethods() {
        this.log('代替方法を試行中...', 'DEBUG');
        
        // Simpler test command that doesn't require special permissions
        const testCommand = {
            header: {
                requestId: this.generateUUID(),
                messagePurpose: "commandRequest",
                version: 1,
                messageType: "commandRequest"
            },
            body: {
                command: "list"  // Simple command that should work without special permissions
            }
        };
        
        this.sendToMinecraft(testCommand);
    }

    // Minecraftにコマンドを送信
    sendToMinecraft(command) {
        if (this.minecraftWs && this.minecraftWs.readyState === WebSocket.OPEN) {
            const jsonString = JSON.stringify(command);
            this.log(`Minecraftに送信: ${jsonString}`, 'DEBUG');
            this.minecraftWs.send(jsonString);
        } else {
            this.log('Minecraft接続が利用できません', 'ERROR');
        }
    }

    // Minecraftからのメッセージハンドラ
    async handleMinecraftMessage(message) {
        this.log(`構造化メッセージ受信: ${JSON.stringify(message, null, 2)}`, 'DEBUG');

        // ヘッダーチェック
        if (!message.header) {
            this.log('ヘッダーがありません', 'WARN');
            return;
        }

        const messagePurpose = message.header.messagePurpose;
        this.log(`メッセージ目的: ${messagePurpose}`, 'DEBUG');

        switch (messagePurpose) {
            case "event":
                await this.handleEvent(message);
                break;
            case "commandResponse":
                this.handleCommandResponse(message);
                break;
            case "error":
                this.log(`Minecraftエラー: ${JSON.stringify(message.body)}`, 'ERROR');
                break;
            default:
                this.log(`未知のメッセージタイプ: ${messagePurpose}`, 'WARN');
        }
    }

    // イベント処理
    async handleEvent(message) {
        if (!message.body) {
            this.log('イベントボディがありません', 'WARN');
            return;
        }

        // チャットメッセージの直接検出
        if (message.body.type === 'chat') {
            const sender = message.body.sender || 'Unknown';
            const text = message.body.message || '';
            await this.sendToDiscord(`${sender}: ${text}`);
            return;
        }

        // イベントデータをログ出力
        this.log(`イベントデータ: ${JSON.stringify(message.body, null, 2)}`, 'DEBUG');

        // Handle other events...
        const eventName = message.body.eventName;
        switch (eventName) {
            case "PlayerMessage":
            case "PlayerChat":
            case "ChatMessage":
                await this.handlePlayerMessage(message.body);
                break;
            case "PlayerJoin":
            case "PlayerConnect":
                await this.handlePlayerJoin(message.body);
                break;
            case "PlayerLeave":
            case "PlayerDisconnect":
                await this.handlePlayerLeave(message.body);
                break;
            default:
                // イベント名がundefinedでもチャットデータがある場合は処理
                if (message.body.message && message.body.sender) {
                    await this.sendToDiscord(`${message.body.sender}: ${message.body.message}`);
                } else {
                    this.log(`未処理のイベント: ${eventName}`, 'DEBUG');
                }
        }
    }

    // コマンドレスポンス処理
    handleCommandResponse(message) {
        this.log(`コマンドレスポンス: ${JSON.stringify(message.body, null, 2)}`, 'DEBUG');
        
        if (message.body) {
            if (message.body.statusCode === -2147483643) {
                this.log('コマンド実行権限がないか、コマンドが無効です', 'WARN');
                return;
            }
            
            if (message.body.statusMessage) {
                this.log(`ステータス: ${message.body.statusMessage}`, 'INFO');
            }
        }
    }

    // プレイヤーメッセージの処理
    async handlePlayerMessage(eventData) {
        this.log(`プレイヤーメッセージ処理: ${JSON.stringify(eventData)}`, 'DEBUG');
        
        // 送信者名とメッセージを取得
        const sender = eventData.sender || eventData.player || eventData.playerName || eventData.source || "Unknown";
        const message = eventData.message || eventData.text || eventData.msg || "";
        
        this.log(`抽出結果 - プレイヤー: ${sender}, メッセージ: ${message}`, 'INFO');

        if (this.shouldForwardMessage(message, sender)) {
            // 新しいフォーマット: A: B の形式で送信
            const formattedMessage = `${sender}: ${message}`;
            await this.sendToDiscord(formattedMessage, null); // 第2引数をnullに変更
        }
    }

    // プレイヤー参加の処理
    async handlePlayerJoin(eventData) {
        const playerName = eventData.player || eventData.playerName || eventData.name || "Unknown";
        this.log(`プレイヤー参加: ${playerName}`, 'INFO');
        await this.sendToDiscord('System', `🟢 ${playerName} がサーバーに参加しました`);
    }

    // プレイヤー退出の処理
    async handlePlayerLeave(eventData) {
        const playerName = eventData.player || eventData.playerName || eventData.name || "Unknown";
        this.log(`プレイヤー退出: ${playerName}`, 'INFO');
        await this.sendToDiscord('System', `🔴 ${playerName} がサーバーから退出しました`);
    }

    // メッセージを転送すべきかチェック
    shouldForwardMessage(message, playerName) {
        if (!message || !message.trim()) {
            this.log('空のメッセージのためスキップ', 'DEBUG');
            return false;
        }
        
        if (message.startsWith('/')) {
            this.log('コマンドのためスキップ', 'DEBUG');
            return false;
        }
        
        if (playerName === "Server" || playerName === "System") {
            this.log('システムメッセージのためスキップ', 'DEBUG');
            return false;
        }
        
        return true;
    }

    // Discordにメッセージを送信
    async sendToDiscord(message, systemMessage = false) {
        try {
            if (!this.discordClient) {
                this.log('Discordクライアントが初期化されていません', 'ERROR');
                return;
            }

            const channel = await this.discordClient.channels.fetch(CONFIG.discord.channelId);
            if (!channel) {
                this.log(`チャンネルID ${CONFIG.discord.channelId} が見つかりません`, 'ERROR');
                return;
            }

            // System messages are sent with emoji prefix
            const finalMessage = systemMessage ? `🔧 ${message}` : message;
            await channel.send(finalMessage);
            this.log(`Discord送信成功: ${finalMessage}`, 'INFO');
        } catch (error) {
            this.log(`Discord送信エラー: ${error.message}`, 'ERROR');
        }
    }

    // UUID生成
    generateUUID() {
        return crypto.randomUUID();
    }

    // アプリケーション開始
    async start() {
        try {
            this.log('Minecraft-Discord Bridgeを開始中...');
            
            // Discord接続
            await this.initDiscord();
            
            // WebSocketサーバー開始
            this.initWebSocketServer();
            
            this.log('ブリッジサーバーが正常に開始されました');
            this.log('デバッグモードが有効です - 詳細なログが出力されます');
        } catch (error) {
            this.log(`開始エラー: ${error.message}`, 'ERROR');
        }
    }

    // アプリケーション終了
    stop() {
        if (this.minecraftWs) {
            this.minecraftWs.terminate();
            this.minecraftWs = null;
        }
        if (this.currentServer) {
            this.currentServer.close();
            this.currentServer = null;
        }
        if (this.discordClient) {
            this.discordClient.destroy();
        }
        this.log('ブリッジサーバーを停止しました');
    }

    // 再接続メソッド
    async reconnectMinecraft() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        try {
            this.log('再接続を開始します...', 'INFO');
            
            // 既存の接続をクリーンアップ
            if (this.minecraftWs) {
                this.minecraftWs.terminate();
                this.minecraftWs = null;
            }

            // サーバーの再初期化を試行
            await new Promise(resolve => setTimeout(resolve, 2000)); // クールダウン待機
            await this.initWebSocketServer();
            
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.log('再接続プロセスが完了しました', 'INFO');
        } catch (error) {
            this.log(`再接続に失敗しました: ${error.message}`, 'ERROR');
            this.isReconnecting = false;
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                this.log(`${this.reconnectDelay/1000}秒後に再試行します...`, 'INFO');
                setTimeout(() => this.reconnectMinecraft(), this.reconnectDelay);
            } else {
                this.log('最大再試行回数に達しました。サーバーを再起動してください。', 'ERROR');
            }
        }
    }
}

// メイン実行部分
const bridge = new MinecraftDiscordBridge();

// 終了処理
process.on('SIGINT', () => {
    console.log('\n終了シグナルを受信しました...');
    bridge.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('終了シグナルを受信しました...');
    bridge.stop();
    process.exit(0);
});

// アプリケーション開始
bridge.start().catch(console.error);

// エクスポート（モジュールとして使用を場合）
module.exports = MinecraftDiscordBridge;