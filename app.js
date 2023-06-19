// 必要なモジュールをインポート  
const fs = require('fs');    
const kuromoji = require('kuromoji');    
const path = require('path');  
const axios = require('axios');    
const socketIO = require('socket.io');   
const express = require('express');    
const http = require('http');    

/*
 ルートディレクトリにconfig.jsonを作ってください
{
  "apiKey": "your-api-key",
  "endpoint": "https://api.example.com"
}
*/

// 設定ファイルを読み込む
const configData = fs.readFileSync('config.json');
const config = JSON.parse(configData);
const promptData = fs.readFileSync('prompt.json');
const prompt = JSON.parse(promptData);

// エンドポイントとAPIキーの設定
const OPENAI_API_ENDPOINT =  config.endpoint;  
const OPENAI_API_KEY = config.apiKey;  

// 定数を定義  
const INPUT_FILE = 'input.vtt';    
const OUTPUT_FILE_NAME = 'output_all.txt';  
const OUTPUT_FILE_SUM = 'output_sum.txt';    

// チャンク分割時のトークン数
const CHUNK_TOKEN_LIMIT = 3000;

// Open AIのトークンリミット数
const OPENAI_TOKEN_LIMIT = 4000;    

// Open AIのトークンリミットのマージン
// KuromojiとOpenAIのトークン数の算出方法が異なるため、少な目にマージンをとる
const OPENAI_TOKEN_LIMIT_MARGIN = 0.9;

// 要約作成用のプロンプト
const SUMMARIZE_PROMPT = prompt.summarize.join("\n");
console.log(SUMMARIZE_PROMPT); 

// 議事録作成用のプロンプト
const GIJIROKU_PROMPT = prompt.gijiroku.join("\n");    
console.log(GIJIROKU_PROMPT); 

// Expressアプリケーションを作成  
const app = express();  
app.use(express.static('public'));  
const server = http.createServer(app);  
 // ペイロードサイズを増やす  
const io = socketIO(server, { maxHttpBufferSize: 5e8 });
  
// 進捗、議事録、完了フラグを初期化  
let progress = 0;    
let summaries = '';  
let giji  = '';    
let isCompleted = false;    
  
// 日本語テキストをトークン化する関数  
function tokenizeText(text, callback) {  
  kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict' }).build((err, tokenizer) => {  
    if (err) throw err;  
    const tokens = tokenizer.tokenize(text);  
    callback(tokens);  
  });  
}  
  
/**********************************************
 *  VTTファイルを読み込む関数  
 **********************************************/
function readVttFile(file) {  
  return new Promise((resolve, reject) => {  
    fs.readFile(file, 'utf8', (err, data) => {  
      if (err) reject(err);  
      resolve(data);  
    });  
  });  
}  

 /**********************************************
 *  OpenAI APIで要約や議事録作成を行う関数   
 *  ※トークン数オーバーで処理に失敗した場合、１度だけ指定トークン数を削減して再実行するようにしたいです。
 **********************************************/
async function useOpenAi(prompt, chunk, _tokenLimit = OPENAI_TOKEN_LIMIT) {
  chunk = cleanText(chunk);
  let retry = false; // 再実行フラグ

  const input_prompt = `${prompt}  
  ${chunk}`;

  const uri = OPENAI_API_ENDPOINT;
  const header = {
    'Content-Type': 'application/json',
    'api-key': OPENAI_API_KEY
  };

  // インプットのトークン数をカウント
  const tokenCount = await countTokens(input_prompt);  

  // maxTokensを計算する
  let maxTokens = Math.floor((_tokenLimit - tokenCount) * OPENAI_TOKEN_LIMIT_MARGIN); 

  const postBody = {
    max_tokens: maxTokens,
    temperature: 0.7,
    top_p: 0.95,
    frequency_penalty: 0,
    presence_penalty: 0,
    stop: ['##'],
    messages: [
      {
        role: 'user',
        content: input_prompt
      }
    ]
  };

  try {
    const response = await axios.post(uri, postBody, {
      headers: header
    });

    const answer = response.data.choices[0].message.content;
    return answer;
  } catch (error) {
    console.error(error);

    if (!retry) {
      retry = true;
      // OpenAIでの処理に失敗した際に１度だけマージンを更に取り直して再実行する  
      return useOpenAi(prompt, chunk, Math.floor(_tokenLimit * OPENAI_TOKEN_LIMIT_MARGIN));  
    } else {
      // 繰り返し処理に失敗したらエラーを返す
      return 'OpenAIでの処理に失敗しました。';
    }
  }
}

/**********************************************
 *  不要な情報を除去してトークン数を節約する関数
 **********************************************/
function cleanText(text) {  
    // タイムスタンプを除去  
    text = text.replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*/g, '');  
    
    // 改行、キャリッジリターン、<v>などを除去  
    text = text.replace(/(\r\n|\n|\r|\\n)/gm, '');  
    text = text.replace(/<v (.*?)>/g, "$1 『");  
    text = text.replace(/(\\n|<\/v>)/g, "』");  
    text = text.replace(/WEBVTT/g, '');  
    
    return text.trim(); // 空白を除去して戻します。  
  }  
    
/**********************************************
 *  VTTファイルを分割し、要約し、コンソールに出力する関数  
 **********************************************/
async function splitAndSummarizeVttFile(vttContent) {  

    try {
      if (!vttContent) {  
          // 何もアップロードされなかったらサンプルファイルから議事録を作成する
          console.log('ローカルファイル');
          vttContent = await readVttFile(INPUT_FILE);  
      } else {
        console.log('アップロードファイル');
      }
      
      // 文章が3000トークン以下になるまで要約を繰り返す
      summaries = await processText(vttContent,CHUNK_TOKEN_LIMIT);

      // まとめた要約をコンソールに出力する  
      console.log(summaries);  

      // まとめた要約をファイルに出力する  
      fs.writeFile(OUTPUT_FILE_NAME, summaries, 'utf8', (err) => {  
        if (err) {  
            console.error('Error writing summaries to file:', err.message);  
        } else {  
            console.log(`Summaries written to ${OUTPUT_FILE_NAME}`);  
        }  
      });  

      // まとめた要約から議事録を作成してファイルに出力する  
      giji = await  useOpenAi(GIJIROKU_PROMPT,summaries);  
      giji = addNewlineAfterPeriod(giji);
      fs.writeFile(OUTPUT_FILE_SUM, giji, 'utf8', (err) => {  
        if (err) {  
            console.error('Error writing summaries to file:', err.message);  
        } else {  
            console.log(`Summaries written to ${OUTPUT_FILE_SUM}`);  
        }  
      });  
      isCompleted = true;  
    
    } catch (err) {  
      console.error('Error:', err.message);  
    }  
  }  
    
/**********************************************
 *  句点の後に改行を入れる関数
 **********************************************/
function addNewlineAfterPeriod(text) {  
  return text.replace(/。/g, '。\n');  
}  
    
/**********************************************  
 *  kuromojiでトークン数をカウントする関数  
 **********************************************/  
async function countTokens(text) {  
  const dicPath = path.join(__dirname, 'node_modules/kuromoji/dict');  
  return new Promise((resolve, reject) => {  
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {  
      if (err) {  
        reject(err);  
        return;  
      }  
      const tokens = tokenizer.tokenize(text);  
      resolve(tokens.length);  
    });  
  });  
}  
  
/**********************************************  
 *  kuromojiで指定のトークンずつ分割して、配列にする関数  
 **********************************************/  
async function splitTextIntoChunks(text, chunkSize) {  
  const tokenCount = await countTokens(text);  
  const dicPath = path.join(__dirname, 'node_modules/kuromoji/dict');  
  return new Promise((resolve, reject) => {  
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {  
      if (err) {  
        reject(err);  
        return;  
      }  
      const tokens = tokenizer.tokenize(text);  
      const chunks = [];  
      for (let i = 0; i < tokenCount; i += chunkSize) {  
        const chunk = tokens.slice(i, i + chunkSize);  
        chunks.push(chunk);  
      }  
      resolve(chunks);  
    });  
  });  
}  

/**********************************************
 *  指定のトークン数以下になるまで要約を繰り返して、トークン数を減らす関数
 **********************************************/
async function processText(text,chunkSize) {  
  let chunks = await splitTextIntoChunks(text, chunkSize);  

  // チャンクの最大値
  const totalChunks = chunks.length;

  // 要約が完了したチャンクのカウント
  let completedChunks = 0;
  
  // OpenAIを使用した回数
  let usedOpenAiCount = 0;

  // 返却する要約した結果
  let result = '';  

  while (true) {  
    const summarizedChunks = [];  
    for (const chunk of chunks) {  
      const chunkText = chunk.map(token => token.surface_form).join('');  
      
       // 要約中の文章を表示  
      console.log(`要約中: ${chunkText}`);
      
      // 少数第一のパーセンテージで進捗を表示する
      console.log(`進捗: ${progress}% Open AI使用回数: ${usedOpenAiCount}回`);

      // 要約を実施
      const summary = await useOpenAi(SUMMARIZE_PROMPT, chunkText);  
      usedOpenAiCount++;

      // 要約結果を表示  
      console.log(`要約結果: ${summary}`); 

      // 要約結果を配列に追加
      summarizedChunks.push(summary);

      // チャンクの処理が完了したら、completedChunks をインクリメントする
      completedChunks++;

      // 進捗率の計算　小数点第一位まで　
      // 一度の要約で複数のチャンクを処理するので、completedChunks / totalChunks で計算するが
      // 要約の集合体が指定のトークン数を上回った場合再要約を行う。その場合進捗は100%を超えることがある。
      progress = ((completedChunks / totalChunks) * 100).toFixed(1);
    }  
  
    // 要約したチャンクを結合する
    const summarizedText = summarizedChunks.join('\n\n');

    // 要約したチャンクを指定のトークン数で分割する
    const summarizedChunksAgain = await splitTextIntoChunks(summarizedText, chunkSize);  

    // 要約の集合体が指定のトークン数を下回っているか確認する
    if (summarizedChunksAgain.length === 1) {  
      // 想定のトークン数を下回っている場合、要約を終了する
      result = summarizedChunksAgain[0].map(token => token.surface_form).join('');  
      break;  
    } else {  
      // 指定のトークン数を上回っている場合、要約を繰り返す
      chunks = summarizedChunksAgain;  
    }  
  }  

  console.log(`最終的なOpen AI使用回数: ${usedOpenAiCount}回`);

  // 結果をかえす
  return result;  
}  
  
/**********************************************
 *  画面上から最新の情報を取得するためのio
 **********************************************/
  io.on('connection', (socket) => {  
    console.log('Client connected');  
    
  // クライアントからのイベントをリッスン  
  socket.on('start_summarization', async (vttContent) => { // vttContentを引数に追加  
    console.log('サーバー側で受信したファイル内容:', vttContent); // デバッグ用  
    await splitAndSummarizeVttFile(vttContent);  
  });  
    
    // クライアントとの接続が切れたときのイベントをリッスン  
    socket.on('disconnect', () => {  
      console.log('Client disconnected');  
    });  
  });  
    
  // 10秒ごとに進捗をクライアントに送信し、100%になったら議事録と要約を表示  
  setInterval(() => {  
    // 現在の進捗を画面に送信
    io.emit('progress', progress);  
    if (isCompleted) {  
      // 完成した議事録を画面に送信
      io.emit('completed', giji);   
      // 完成した要約を画面に送信
      io.emit('summarized_text', summaries); 
    }  
     // 10秒おきに更新する
  }, 10000);  
  
// エンドポイントを作成してindex.htmlを提供  
app.get('/gijiroku', (req, res) => {  
    res.sendFile(__dirname + '/public/index.html');  
  });  

// サーバーを開始  
const PORT = process.env.PORT || 3000;  
server.listen(PORT, () => console.log(`Server running http://localhost:${PORT}/gijiroku/`));  