import { useEffect, useRef, useState } from 'react';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  
  // 雙馬達與遊戲分數狀態
  const [armAngle, setArmAngle] = useState(90);   
  // 初始狀態改為 170（安全張開待命狀態）
  const [clawAngle, setClawAngle] = useState(170); 
  const [score, setScore] = useState(0);           
  
  // 獨立遊戲流程狀態
  const [isPlaying, setIsPlaying] = useState(false); 
  const [timeLeft, setTimeLeft] = useState(120);     
  const [isGameOver, setIsGameOver] = useState(false); 

  const [serialPort, setSerialPort] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // 用 Ref 同步即時狀態
  const isPlayingRef = useRef(false);
  const timeLeftRef = useRef(120);

  // 遊戲狀態管理
  const gameObjectsRef = useRef({
    items: [],         
    lastSpawnTime: 0,  
    playerHand: { x: 320, y: 240, isFist: false } 
  });

  const ITEM_TYPES = {
    BOTTLE: { emoji: "🥤", type: "garbage", points: 10 },
    CAN: { emoji: "🥫", type: "garbage", points: 10 },
    PLASTIC_BAG: { emoji: "🛍️", type: "garbage", points: 10 },
    FISH: { emoji: "🐟", type: "fish", points: -20 } 
  };

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
        .catch((err) => {
          console.error("Camera access denied:", err);
        });
    };

    const predictWebcam = async () => {
      if (!videoRef.current || !gestureRecognizer || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const canvasCtx = canvas.getContext("2d");
      const startTimeMs = performance.now();
      
      const results = gestureRecognizer.recognizeForVideo(videoRef.current, startTimeMs);

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      const drawingUtils = new DrawingUtils(canvasCtx);
      const gameState = gameObjectsRef.current;

      // --- 【1. 手部控制邏輯】 ---
      if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0];
        const handCenter = landmarks[9]; 
        const wrist = landmarks[0];      

        gameState.playerHand.x = handCenter.x * canvas.width;
        gameState.playerHand.y = handCenter.y * canvas.height;

        if (results.gestures && results.gestures.length > 0) {
          const gestureName = results.gestures[0][0].categoryName;
          gameState.playerHand.isFist = (gestureName === "Closed_Fist");
        }

        let calcArmAngle = 180 - ((wrist.y - 0.2) / 0.6) * 180;
        calcArmAngle = Math.max(0, Math.min(180, Math.round(calcArmAngle)));
        setArmAngle(calcArmAngle);

        // 控制驅動角度：握拳為 180 度（夾緊），平手為 110 度（張開）
        if (gameState.playerHand.isFist) {
          setClawAngle(180); 
        } else {
          setClawAngle(110); 
        }

        // 繪製手部骨架
        canvasCtx.shadowColor = '#00e5ff';
        canvasCtx.shadowBlur = 10;
        drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#b2ebf2", lineWidth: 4 });
        drawingUtils.drawLandmarks(landmarks, { color: "#ffffff", lineWidth: 2, radius: 4 });
        canvasCtx.shadowBlur = 0;
      }

      // --- 【2. 遊戲物件生成邏輯】 ---
      const isRushHour = timeLeftRef.current <= 60; 
      const spawnCooldown = isRushHour ? 800 : 1500; 
      const speedMultiplier = isRushHour ? 1.6 : 1.0; 

      if (isPlayingRef.current && startTimeMs - gameState.lastSpawnTime > spawnCooldown) {
        gameState.lastSpawnTime = startTimeMs;

        const keys = Object.keys(ITEM_TYPES);
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        const config = ITEM_TYPES[randomKey];

        let itemData = {
          id: startTimeMs + Math.random(),
          emoji: config.emoji,
          type: config.type,
          points: config.points,
          radius: 50             
        };

        if (config.type === "garbage") {
          itemData.x = Math.random() * (canvas.width - 80) + 40;
          itemData.y = -45;
          itemData.speedX = 0;
          itemData.speedY = (Math.random() * 2 + 2) * speedMultiplier;
          itemData.flipH = false; 
        } else {
          const fromLeft = Math.random() > 0.5;
          itemData.x = fromLeft ? -45 : canvas.width + 45;
          itemData.y = Math.random() * (canvas.height - 150) + 50;
          itemData.speedY = 0;

          if (fromLeft) {
            itemData.speedX = (Math.random() * 2 + 2) * speedMultiplier; 
            itemData.flipH = true;  
          } else {
            itemData.speedX = -(Math.random() * 2 + 2) * speedMultiplier; 
            itemData.flipH = false; 
          }
        }

        gameState.items.push(itemData);
      }

      // --- 【3. 夾取判定與繪製遊戲物件】 ---
      gameState.items = gameState.items.filter(item => {
        if (isPlayingRef.current) {
          item.x += item.speedX; 
          item.y += item.speedY; 

          if (results.landmarks && results.landmarks.length > 0) {
            const dx = item.x - gameState.playerHand.x;
            const dy = item.y - gameState.playerHand.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < item.radius + 15 && gameState.playerHand.isFist) {
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

        const inBoundsX = item.x > -60 && item.x < canvas.width + 60;
        const inBoundsY = item.y < canvas.height + 60;
        return inBoundsX && inBoundsY;
      });

      // --- 【4. 繪製手部科幻準心】 ---
      if (results.landmarks && results.landmarks.length > 0) {
        const { x, y, isFist } = gameState.playerHand;
        
        canvasCtx.save();
        canvasCtx.strokeStyle = isFist ? "#ff1744" : "#00e5ff"; 
        canvasCtx.lineWidth = 4; 
        canvasCtx.shadowColor = isFist ? "#ff1744" : "#00e5ff";
        canvasCtx.shadowBlur = 10;

        canvasCtx.beginPath();
        canvasCtx.arc(x, y, isFist ? 20 : 35, 0, Math.PI * 2);
        canvasCtx.stroke();

        canvasCtx.beginPath();
        canvasCtx.moveTo(x - 8, y); canvasCtx.lineTo(x + 8, y);
        canvasCtx.moveTo(x, y - 8); canvasCtx.lineTo(x, y + 8);
        canvasCtx.stroke();
        canvasCtx.restore();
      }

      animationFrameId = requestAnimationFrame(predictWebcam);
    };

    const initializeMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
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
      if (serialPort && serialPort.writable) {
        const writer = serialPort.writable.getWriter();
        const data = new TextEncoder().encode(`${armAngle},${clawAngle}\n`);
        await writer.write(data);
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
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: 'linear-gradient(135deg, #001f3f 0%, #006064 100%)',
      textAlign: 'center', 
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', 
      padding: '40px 20px',
      color: '#ffffff',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0, pointerEvents: 'none', opacity: 0.1,
        background: 'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.8), transparent 60%)',
      }}></div>

      <div style={{ position: 'relative', zIndex: 1 }}>
        <h1 style={{ fontSize: '3rem', fontWeight: '300', letterSpacing: '2px', marginBottom: '10px', textShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
          <span style={{ color: '#80deea', fontWeight: 'bold' }}>KCC Ocean Cleaner</span>
        </h1>
        <p style={{ fontSize: '1.2rem', color: '#b2ebf2', fontWeight: '300', letterSpacing: '1px', marginBottom: '20px' }}>
          AI Motion Interaction | Control Arm Height & Claw State
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px', marginBottom: '30px' }}>
          <button 
            onClick={connectArduino}
            style={{ 
              padding: '12px 35px', fontSize: '16px', cursor: 'pointer', fontWeight: '600', letterSpacing: '1px',
              background: serialPort ? 'rgba(76, 175, 80, 0.8)' : 'rgba(255, 255, 255, 0.15)', color: '#fff', 
              border: '1px solid rgba(255, 255, 255, 0.3)', backdropFilter: 'blur(5px)', borderRadius: '50px', 
              boxShadow: '0 5px 15px rgba(0,0,0,0.2)', transition: 'all 0.3s ease'
            }}
          >
            {serialPort ? "🤖 Robot Connected" : "🔌 Connect Robot Arm"}
          </button>

          {isPlaying ? (
            <button onClick={stopGame} style={{...startBtnStyle, background: 'linear-gradient(45deg, #ff1744, #d50000)'}}>
              STOP GAME
            </button>
          ) : (
            <button onClick={startGame} disabled={!isLoaded} style={{...startBtnStyle, opacity: isLoaded ? 1 : 0.5}}>
              {isGameOver ? "PLAY AGAIN" : "START GAME"}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '25px' }}>
          <div style={{
            background: 'rgba(0, 229, 255, 0.1)', border: '2px solid #00e5ff', borderRadius: '15px', padding: '10px 30px',
            boxShadow: '0 0 15px rgba(0, 229, 255, 0.2)', backdropFilter: 'blur(5px)'
          }}>
            <span style={{ fontSize: '1rem', letterSpacing: '1px', color: '#b2ebf2', marginRight: '15px' }}>SCORE</span>
            <span style={{ fontSize: '2rem', fontWeight: 'bold', fontFamily: 'monospace' }}>{score}</span>
          </div>

          <div style={{
            background: timeLeft <= 10 ? 'rgba(255, 23, 68, 0.15)' : timeLeft <= 60 ? 'rgba(255, 110, 64, 0.15)' : 'rgba(0, 229, 255, 0.1)',
            border: timeLeft <= 10 ? '2px solid #ff1744' : timeLeft <= 60 ? '2px solid #ff6e40' : '2px solid #00e5ff', 
            borderRadius: '15px', padding: '10px 30px',
            boxShadow: timeLeft <= 10 ? '0 0 15px rgba(255, 23, 68, 0.4)' : timeLeft <= 60 ? '0 0 15px rgba(255, 110, 64, 0.4)' : '0 0 15px rgba(0, 229, 255, 0.2)',
            backdropFilter: 'blur(5px)', transition: 'all 0.3s'
          }}>
            <span style={{ fontSize: '1rem', letterSpacing: '1px', color: timeLeft <= 10 ? '#ff8a80' : timeLeft <= 60 ? '#ff9e80' : '#b2ebf2', marginRight: '15px' }}>TIME</span>
            <span style={{ fontSize: '2rem', fontWeight: 'bold', fontFamily: 'monospace', color: timeLeft <= 10 ? '#ff1744' : timeLeft <= 60 ? '#ff6e40' : '#fff' }}>
              {formatTime(timeLeft)}
            </span>
          </div>
        </div>

        {!isLoaded && <h3 style={{ color: '#80deea', animation: 'pulse 1.5s infinite' }}>Loading AI Vision Model...</h3>}

        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'stretch', gap: '30px', marginTop: '20px' }}>
          <div style={{ 
            position: 'relative', borderRadius: '20px', overflow: 'hidden', background: 'rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(10px)', border: '1px solid rgba(255, 255, 255, 0.2)', boxShadow: '0 15px 35px rgba(0,0,0,0.3)', padding: '10px'
          }}>
            <video ref={videoRef} autoPlay playsInline style={{ width: '640px', height: '480px', transform: 'scaleX(-1)', borderRadius: '12px' }} />
            <canvas ref={canvasRef} width="640" height="480" style={{ position: 'absolute', top: 10, left: 10, transform: 'scaleX(-1)', borderRadius: '12px' }} />

            {isGameOver && (
              <div style={{
                position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0, 31, 63, 0.9)', border: '2px solid #ff1744', borderRadius: '12px',
                padding: '15px 30px', zIndex: 10, boxShadow: '0 10px 25px rgba(255,23,68,0.3)', textAlign: 'center'
              }}>
                <h3 style={{ margin: '0 0 5px 0', color: '#ff1744', letterSpacing: '1px' }}>GAME OVER</h3>
                <p style={{ margin: 0, fontSize: '1rem' }}>清理完成！最終得分：<span style={{ color: '#00e5ff', fontWeight: 'bold' }}>{score}</span></p>
              </div>
            )}
          </div>

          {/* 右側機械臂數值條 */}
          <div style={{ 
            height: '500px', width: '100px', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '30px', 
            border: '1px solid rgba(255, 255, 255, 0.1)', boxShadow: 'inset 0 4px 10px rgba(0,0,0,0.5), 0 10px 20px rgba(0,0,0,0.2)',
            position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '8px'
          }}>
            {/* ⭐ 核心修正：當角度 > 140 (握拳時) 亮紅燈，否則亮藍燈 */}
            <div style={{ 
              height: `${(armAngle / 180) * 100}%`, width: '100%', 
              background: clawAngle > 140 ? 'linear-gradient(to top, #e53935, #ff8a80)' : 'linear-gradient(to top, #00acc1, #84ffff)',
              borderRadius: '25px', transition: 'height 0.1s ease-out',
              boxShadow: clawAngle > 140 ? '0 0 15px rgba(255, 23, 68, 0.5)' : '0 0 15px rgba(132, 255, 255, 0.5)'
            }} />
            
            <div style={{ 
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', 
              fontWeight: 'bold', fontSize: '14px', color: '#fff', textShadow: '0 2px 4px rgba(0,0,0,0.8)',
              width: '90%', textAlign: 'center', lineHeight: '1.5'
            }}>
              <div>高度</div>
              <div style={{ fontSize: '20px', color: '#84ffff' }}>{armAngle}°</div>
              <div style={{ marginTop: '15px', borderTop: '1px solid rgba(255,255,255,0.3)', paddingTop: '10px' }}>爪子</div>
              {/* ⭐ 核心修正：大於 140 度顯示夾緊，否則顯示張開 */}
              <div style={{ fontSize: '16px', color: clawAngle > 140 ? '#ff8a80' : '#b2ebf2' }}>
                {clawAngle > 140 ? "張開" : "夾緊"}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

const startBtnStyle = {
  padding: '12px 40px',
  fontSize: '16px',
  fontWeight: 'bold',
  letterSpacing: '1px',
  color: '#ffffff',
  background: 'linear-gradient(45deg, #00e5ff, #00a5bb)',
  border: 'none',
  borderRadius: '50px',
  cursor: 'pointer',
  boxShadow: '0 5px 15px rgba(0, 229, 255, 0.3)',
  transition: 'transform 0.2s ease, boxShadow 0.2s ease',
  outline: 'none'
};

export default App;
