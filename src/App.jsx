import { useEffect, useRef, useState } from 'react';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';

const ITEM_TYPES = {
  BOTTLE: { emoji: "🥤", type: "garbage", points: 10 },
  CAN: { emoji: "🥫", type: "garbage", points: 10 },
  PLASTIC_BAG: { emoji: "🛍️", type: "garbage", points: 10 },
  FISH: { emoji: "🐟", type: "fish", points: -20 }
};

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // 雙馬達與遊戲分數狀態
  const [armAngle, setArmAngle] = useState(90);   
  const [clawAngle, setClawAngle] = useState(110); // 初始狀態設為 110 (依據新邏輯，110 為放開待命狀態)
  const [score, setScore] = useState(0);           

  // 獨立遊戲流程狀態
  const [isPlaying, setIsPlaying] = useState(false); 
  const [timeLeft, setTimeLeft] = useState(120);     
  const [isGameOver, setIsGameOver] = useState(false); 
  const [serialPort, setSerialPort] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // 用 Ref 同步即時狀態避免 useEffect 閉包問題
  const isPlayingRef = useRef(false);
  const timeLeftRef = useRef(120);
  const gameObjectsRef = useRef({ items: [], lastSpawnTime: 0, playerHand: { x: 320, y: 240, isFist: false } });

  // 計時器倒數邏輯
  useEffect(() => {
    let timerId;
    if (isPlaying && timeLeft > 0) {
      timerId = setInterval(() => {
        setTimeLeft(prev => {
          const nextTime = prev - 1;
          timeLeftRef.current = nextTime; 
          return nextTime;
        });
      }, 1000);
    } else if (timeLeft === 0 && isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false; 
      setIsGameOver(true);
    }
    return () => clearInterval(timerId);
  }, [isPlaying, timeLeft]);

  // 開始遊戲
  const startGame = () => {
    setScore(0);
    setTimeLeft(120);
    timeLeftRef.current = 120;
    setIsGameOver(false);
    gameObjectsRef.current.items = []; 
    setIsPlaying(true);
    isPlayingRef.current = true; 
  };

  // 強制結束/離開遊戲
  const stopGame = () => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    setIsGameOver(false);
    gameObjectsRef.current.items = [];
  };

  // 核心 MediaPipe 與遊戲渲染邏輯
  useEffect(() => {
    let gestureRecognizer;
    let animationFrameId;

    const startCamera = () => {
      navigator.mediaDevices.getUserMedia({ video: true })
        .then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.addEventListener("loadeddata", predictWebcam);
          }
        })
        .catch((err) => console.error("Camera access denied:", err));
    };

    // 子功能 1: 處理手部辨識與角度計算
    const handleHandControl = (results, canvas, gameState) => {
      if (!results.landmarks || results.landmarks.length === 0) return;
      
      const landmarks = results.landmarks[0];
      const handCenter = landmarks[9]; 
      const wrist = landmarks[0];      

      gameState.playerHand.x = handCenter.x * canvas.width;
      gameState.playerHand.y = handCenter.y * canvas.height;

      if (results.gestures && results.gestures.length > 0) {
        gameState.playerHand.isFist = results.gestures[0][0].categoryName === "Closed_Fist";
      }

      let calcArmAngle = 180 - ((wrist.y - 0.2) / 0.6) * 180;
      setArmAngle(Math.max(0, Math.min(180, Math.round(calcArmAngle))));
      
      // ⭐ 核心修正 1：對調角度值以符合實體機器人方向 (✊ 握拳時傳送 170 度，✋ 平手時傳送 110 度)
      setClawAngle(gameState.playerHand.isFist ? 170 : 110); 
    };

    // 子功能 2: 繪製手部骨架
    const drawHandSkeleton = (canvasCtx, landmarks) => {
      if (!landmarks || landmarks.length === 0) return;
      const drawingUtils = new DrawingUtils(canvasCtx);
      canvasCtx.shadowColor = '#00e5ff';
      canvasCtx.shadowBlur = 10;
      drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#b2ebf2", lineWidth: 4 });
      drawingUtils.drawLandmarks(landmarks, { color: "#ffffff", lineWidth: 2, radius: 4 });
      canvasCtx.shadowBlur = 0;
    };

    // 子功能 3: 遊戲物件生成邏輯
    const spawnGameItems = (startTimeMs, gameState, canvas) => {
      const isRushHour = timeLeftRef.current <= 60; 
      const spawnCooldown = isRushHour ? 800 : 1500; 
      const speedMultiplier = isRushHour ? 1.6 : 1.0; 

      if (isPlayingRef.current && startTimeMs - gameState.lastSpawnTime > spawnCooldown) {
        gameState.lastSpawnTime = startTimeMs;
        const keys = Object.keys(ITEM_TYPES);
        const config = ITEM_TYPES[keys[Math.floor(Math.random() * keys.length)]];

        let itemData = {
          id: startTimeMs + Math.random(),
          emoji: config.emoji,
          type: config.type,
          points: config.points,
          radius: 50,
          x: 0, y: 0, speedX: 0, speedY: 0, flipH: false
        };

        if (config.type === "garbage") {
          itemData.x = Math.random() * (canvas.width - 80) + 40;
          itemData.y = -45;
          itemData.speedY = (Math.random() * 2 + 2) * speedMultiplier;
        } else {
          const fromLeft = Math.random() > 0.5;
          itemData.x = fromLeft ? -45 : canvas.width + 45;
          itemData.y = Math.random() * (canvas.height - 150) + 50;
          itemData.speedX = (Math.random() * 2 + 2) * speedMultiplier * (fromLeft ? 1 : -1);
          itemData.flipH = fromLeft;
        }
        gameState.items.push(itemData);
      }
    };

    // 子功能 4: 夾取判定與物件繪製
    const updateAndDrawItems = (canvasCtx, results, gameState, canvas) => {
      gameState.items = gameState.items.filter(item => {
        if (isPlayingRef.current) {
          item.x += item.speedX; 
          item.y += item.speedY; 

          if (results.landmarks && results.landmarks.length > 0) {
            const dx = item.x - gameState.playerHand.x;
            const dy = item.y - gameState.playerHand.y;
            if (Math.sqrt(dx * dx + dy * dy) < item.radius + 15 && gameState.playerHand.isFist) {
              setScore(prev => prev + item.points);
              return false;
            }
          }

          canvasCtx.save(); 
          if (item.flipH) {
            canvasCtx.translate(item.x, item.y);
            canvasCtx.scale(-1, 1); 
            canvasCtx.translate(-item.x, -item.y);
          }
          canvasCtx.font = "70px Arial"; 
          canvasCtx.textAlign = "center";
          canvasCtx.textBaseline = "middle";
          canvasCtx.fillText(item.emoji, item.x, item.y);
          canvasCtx.restore(); 
        }
        return item.x > -60 && item.x < canvas.width + 60 && item.y < canvas.height + 60;
      });
    };

    // 子功能 5: 繪製手部科幻準心
    const drawCrosshair = (canvasCtx, gameState) => {
      const { x, y, isFist } = gameState.playerHand;
      canvasCtx.save();
      canvasCtx.strokeStyle = canvasCtx.shadowColor = isFist ? "#ff1744" : "#00e5ff"; 
      canvasCtx.lineWidth = 4; 
      canvasCtx.shadowBlur = 10;

      canvasCtx.beginPath();
      canvasCtx.arc(x, y, isFist ? 20 : 35, 0, Math.PI * 2);
      canvasCtx.stroke();

      canvasCtx.beginPath();
      canvasCtx.moveTo(x - 8, y); canvasCtx.lineTo(x + 8, y);
      canvasCtx.moveTo(x, y - 8); canvasCtx.lineTo(x, y + 8);
      canvasCtx.stroke();
      canvasCtx.restore();
    };

    // 主循環主相機預測控制
    const predictWebcam = async () => {
      if (!videoRef.current || !gestureRecognizer || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const canvasCtx = canvas.getContext("2d");
      const startTimeMs = performance.now();
      const results = gestureRecognizer.recognizeForVideo(videoRef.current, startTimeMs);
      const gameState = gameObjectsRef.current;

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

      handleHandControl(results, canvas, gameState);
      if (results.landmarks && results.landmarks.length > 0) {
        drawHandSkeleton(canvasCtx, results.landmarks[0]);
      }
      spawnGameItems(startTimeMs, gameState, canvas);
      updateAndDrawItems(canvasCtx, results, gameState, canvas);
      if (results.landmarks && results.landmarks.length > 0) {
        drawCrosshair(canvasCtx, gameState);
      }

      animationFrameId = requestAnimationFrame(predictWebcam);
    };

    const initializeMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO", numHands: 1
        });
        setIsLoaded(true);
        startCamera();
      } catch (error) {
        console.error("MediaPipe initialization failed:", error);
      }
    };

    initializeMediaPipe();

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (gestureRecognizer) gestureRecognizer.close();
    };
  }, []); 

  // 監聽雙角度變化並發送至 Arduino
  useEffect(() => {
    const sendData = async () => {
      if (serialPort?.writable) {
        const writer = serialPort.writable.getWriter();
        await writer.write(new TextEncoder().encode(`${armAngle},${clawAngle}\n`));
        writer.releaseLock();
      }
    };
    sendData();
  }, [armAngle, clawAngle, serialPort]);

  const connectArduino = async () => {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      setSerialPort(port);
    } catch (err) {
      console.error("Connection failed:", err);
      alert("Connection failed. Please use Chrome browser and select the Arduino port.");
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  };

  return (
    <div style={styles.container}>
      <div style={styles.bgOverlay}></div>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <h1 style={styles.title}><span style={{ color: '#80deea', fontWeight: 'bold' }}>KCC Ocean Cleaner</span></h1>
        <p style={styles.subtitle}>AI Motion Interaction | Control Arm Height & Claw State</p>

        <div style={styles.btnGroup}>
          <button onClick={connectArduino} style={{ ...styles.robotBtn, background: serialPort ? 'rgba(76, 175, 80, 0.8)' : 'rgba(255, 255, 255, 0.15)' }}>
            {serialPort ? "🤖 Robot Connected" : "🔌 Connect Robot Arm"}
          </button>
          {isPlaying ? (
            <button onClick={stopGame} style={{...styles.startBtn, background: 'linear-gradient(45deg, #ff1744, #d50000)'}}>STOP GAME</button>
          ) : (
            <button onClick={startGame} disabled={!isLoaded} style={{...styles.startBtn, opacity: isLoaded ? 1 : 0.5}}>{isGameOver ? "PLAY AGAIN" : "START GAME"}</button>
          )}
        </div>

        <div style={styles.dashBoard}>
          <div style={styles.scoreBoard}>
            <span style={styles.boardLabel}>SCORE</span>
            <span style={styles.boardVal}>{score}</span>
          </div>
          <div style={{
            ...styles.timeBoard,
            background: timeLeft <= 10 ? 'rgba(255, 23, 68, 0.15)' : timeLeft <= 60 ? 'rgba(255, 110, 64, 0.15)' : 'rgba(0, 229, 255, 0.1)',
            borderColor: timeLeft <= 10 ? '#ff1744' : timeLeft <= 60 ? '#ff6e40' : '#00e5ff',
          }}>
            <span style={{ ...styles.boardLabel, color: timeLeft <= 10 ? '#ff8a80' : timeLeft <= 60 ? '#ff9e80' : '#b2ebf2' }}>TIME</span>
            <span style={{ ...styles.boardVal, color: timeLeft <= 10 ? '#ff1744' : timeLeft <= 60 ? '#ff6e40' : '#fff' }}>{formatTime(timeLeft)}</span>
          </div>
        </div>

        {!isLoaded && <h3 style={{ color: '#80deea' }}>Loading AI Vision Model...</h3>}

        <div style={styles.gameContainer}>
          <div style={styles.videoWrapper}>
            <video ref={videoRef} autoPlay playsInline style={styles.video} />
            <canvas ref={canvasRef} width="640" height="480" style={styles.canvas} />
            {isGameOver && (
              <div style={styles.gameOverModal}>
                <h3 style={{ margin: '0 0 5px 0', color: '#ff1744', letterSpacing: '1px' }}>GAME OVER</h3>
                <p style={{ margin: 0, fontSize: '1rem' }}>清理完成！最終得分：<span style={{ color: '#00e5ff', fontWeight: 'bold' }}>{score}</span></p>
              </div>
            )}
          </div>

          {/* 右側機械臂數值條 */}
          <div style={styles.statusBar}>
            {/* ⭐ 核心修正 2：將條件改為 clawAngle > 140。當大於 140 (握拳 170 度) 時能量條亮紅燈表示夾緊 */}
            <div style={{ 
              height: `${(armAngle / 180) * 100}%`, width: '100%', 
              background: clawAngle > 140 ? 'linear-gradient(to top, #e53935, #ff8a80)' : 'linear-gradient(to top, #00acc1, #84ffff)',
              borderRadius: '25px', transition: 'height 0.1s ease-out',
            }} />
            <div style={styles.statusTextWrapper}>
              <div>高度</div>
              <div style={{ fontSize: '20px', color: '#84ffff' }}>{armAngle}°</div>
              <div style={{ marginTop: '15px', borderTop: '1px solid rgba(255,255,255,0.3)', paddingTop: '10px' }}>爪子</div>
              {/* ⭐ 核心修正 3：文字與色彩判斷改為 > 140，讓畫面正確顯示 夾緊 / 張開 */}
              <div style={{ fontSize: '16px', color: clawAngle > 140 ? '#ff8a80' : '#b2ebf2' }}>
                {clawAngle > 140 ? "夾緊" : "張開"}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// 內聯樣式物件
const styles = {
  container: { minHeight: '100vh', background: 'linear-gradient(135deg, #001f3f 0%, #006064 100%)', textAlign: 'center', fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', padding: '40px 20px', color: '#ffffff', position: 'relative', overflow: 'hidden' },
  bgOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0, pointerEvents: 'none', opacity: 0.1, background: 'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.8), transparent 60%)' },
  title: { fontSize: '3rem', fontWeight: '300', letterSpacing: '2px', marginBottom: '10px', textShadow: '0 4px 10px rgba(0,0,0,0.3)' },
  subtitle: { fontSize: '1.2rem', color: '#b2ebf2', fontWeight: '300', letterSpacing: '1px', marginBottom: '20px' },
  btnGroup: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px', marginBottom: '30px' },
  robotBtn: { padding: '12px 35px', fontSize: '16px', cursor: 'pointer', fontWeight: '600', letterSpacing: '1px', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.3)', backdropFilter: 'blur(5px)', borderRadius: '50px', boxShadow: '0 5px 15px rgba(0,0,0,0.2)', transition: 'all 0.3s ease' },
  startBtn: { padding: '12px 40px', fontSize: '16px', fontWeight: 'bold', letterSpacing: '1px', color: '#ffffff', background: 'linear-gradient(45deg, #00e5ff, #00a5bb)', border: 'none', borderRadius: '50px', cursor: 'pointer', boxShadow: '0 5px 15px rgba(0, 229, 255, 0.3)', transition: 'transform 0.2s ease, boxShadow 0.2s ease', outline: 'none' },
  dashBoard: { display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '25px' },
  scoreBoard: { background: 'rgba(0, 229, 255, 0.1)', border: '2px solid #00e5ff', borderRadius: '15px', padding: '10px 30px', boxShadow: '0 0 15px rgba(0, 229, 255, 0.2)', backdropFilter: 'blur(5px)' },
  timeBoard: { borderRadius: '15px', border: '2px solid', padding: '10px 30px', backdropFilter: 'blur(5px)', transition: 'all 0.3s' },
  boardLabel: { fontSize: '1rem', letterSpacing: '1px', color: '#b2ebf2', marginRight: '15px' },
  boardVal: { fontSize: '2rem', fontWeight: 'bold', fontFamily: 'monospace' },
  gameContainer: { display: 'flex', justifyContent: 'center', alignItems: 'stretch', gap: '30px', marginTop: '20px' },
  videoWrapper: { position: 'relative', borderRadius: '20px', overflow: 'hidden', background: 'rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255, 255, 255, 0.2)', boxShadow: '0 15px 35px rgba(0,0,0,0.3)', padding: '10px' },
  video: { width: '640px', height: '480px', transform: 'scaleX(-1)', borderRadius: '12px' },
  canvas: { position: 'absolute', top: 10, left: 10, transform: 'scaleX(-1)', borderRadius: '12px' },
  gameOverModal: { position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0, 31, 63, 0.9)', border: '2px solid #ff1744', borderRadius: '12px', padding: '15px 30px', zIndex: 10, boxShadow: '0 10px 25px rgba(255,23,68,0.3)', textAlign: 'center' },
  statusBar: { height: '500px', width: '100px', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '30px', border: '1px solid rgba(255, 255, 255, 0.1)', boxShadow: 'inset 0 4px 10px rgba(0,0,0,0.5), 0 10px 20px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '8px' },
  statusTextWrapper: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 'bold', fontSize: '14px', color: '#fff', textShadow: '0 2px 4px rgba(0,0,0,0.8)', width: '90%', textAlign: 'center', lineHeight: '1.5' }
};

export default App;
