import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { StateKey } from "../constants";
import toast from "react-hot-toast";

const MAX_STABILITY_TIME = 7;
const SOCKET_TIMEOUT = 15000;
const TIMEOUT_MESSAGE = "Не удается отследить данные, попробуйте еще раз или свяжитесь с администрацией.";

type SensorData = {
    temperature?: string;
    alcoholLevel?: string;
    measurementComplete?: boolean;
};

type HealthCheckState = {
    currentState: StateKey;
    stabilityTime: number;
    temperatureData: { temperature: number };
    alcoholData: { alcoholLevel: string | null };
    faceId: string | null;
    secondsLeft: number;
};

const STATE_SEQUENCE: StateKey[] = ["TEMPERATURE", "ALCOHOL"];

export const useHealthCheck = (): HealthCheckState & {
    handleComplete: () => Promise<void>;
    setCurrentState: React.Dispatch<React.SetStateAction<StateKey>>;
} => {
    const navigate = useNavigate();
    const [state, setState] = useState<HealthCheckState>({
        currentState: "TEMPERATURE",
        stabilityTime: 0,
        temperatureData: { temperature: 0 },
        alcoholData: { alcoholLevel: null },
        faceId: null, // ✅ Preloaded Face ID
        secondsLeft: 15,
    });

    const refs = useRef({
        socket: null as Socket | null,
        timeout: null as NodeJS.Timeout | null,
        lastDataTime: Date.now(),
        hasTimedOut: false,
        isSubmitting: false,
    }).current;

    // ✅ Preload Face ID once
    useEffect(() => {
        const storedFaceId = localStorage.getItem("faceId");
        if (storedFaceId) {
            setState((prev) => ({ ...prev, faceId: storedFaceId }));
        }
    }, []);

    const updateState = useCallback(
        <K extends keyof HealthCheckState>(updates: Pick<HealthCheckState, K>) => {
            setState((prev) => ({ ...prev, ...updates }));
        },
        []
    );

    const handleTimeout = useCallback(() => {
        if (refs.hasTimedOut) return;
        refs.hasTimedOut = true;

        toast.error(TIMEOUT_MESSAGE, {
            duration: 3000,
            style: { background: "#272727", color: "#fff", borderRadius: "8px" },
        });
        navigate("/");
    }, [navigate]);

    const handleDataEvent = useCallback(
        (data: SensorData) => {
            if (!data) {
                console.warn("⚠️ Received empty data packet");
                return;
            }

            console.log("📡 Full sensor data received:", data);
            refs.lastDataTime = Date.now();

            if (refs.timeout) clearTimeout(refs.timeout);
            refs.timeout = setTimeout(handleTimeout, SOCKET_TIMEOUT);

            let newAlcoholStatus = state.alcoholData.alcoholLevel;
            let newTemperature = state.temperatureData.temperature;

            // ✅ Update temperature progress
            if (data.temperature) {
                newTemperature = Number(data.temperature);
                setState((prev) => ({
                    ...prev,
                    temperatureData: { temperature: newTemperature },
                    stabilityTime: Math.min(prev.stabilityTime + 1, MAX_STABILITY_TIME),
                }));
            }

            // ✅ Once `measurementComplete` is received, finalize alcohol level
            if (data.measurementComplete && (data.alcoholLevel === "normal" || data.alcoholLevel === "abnormal")) {
                console.log("✅ Final alcohol level detected:", data.alcoholLevel);
                newAlcoholStatus = data.alcoholLevel;

                // ✅ Save result
                localStorage.setItem("alcoholResult", JSON.stringify({ alcoholLevel: newAlcoholStatus }));

                // ✅ Update UI and progress bar
                setState((prev) => ({
                    ...prev,
                    stabilityTime: MAX_STABILITY_TIME,
                    alcoholData: { alcoholLevel: newAlcoholStatus },
                }));

                // ✅ Navigate to complete-authentication
                setTimeout(() => {
                    navigate("/complete-authentication", { state: { success: true } });
                }, 1000);
            }
        },
        [handleTimeout, state.currentState, state.alcoholData.alcoholLevel, state.temperatureData.temperature, state.stabilityTime, navigate]
    );

    useEffect(() => {
        if (refs.socket) {
            refs.socket.off("temperature");
            refs.socket.off("alcohol");
        }

        refs.hasTimedOut = false;

        const SERVER_URL = process.env.VITE_SERVER_URL || "http://localhost:3001";
        console.log("🔗 Connecting to WebSocket:", SERVER_URL);

        const socket = io(SERVER_URL, {
            transports: ["websocket"],
            reconnection: true,
            reconnectionAttempts: 20,
            reconnectionDelay: 10000,
        });

        socket.on("connect", () => {
            console.log("✅ WebSocket connected successfully.");
            refs.socket = socket;
        });

        socket.on("disconnect", (reason) => {
            console.warn("⚠️ WebSocket disconnected:", reason);
        });

        socket.on("connect_error", (err) => {
            console.error("❌ WebSocket connection error:", err);
        });

        socket.on("temperature", handleDataEvent);
        socket.on("alcohol", handleDataEvent);

        refs.socket = socket;

        return () => {
            socket.off("temperature");
            socket.off("alcohol");
        };
    }, [handleDataEvent, navigate]);

    const handleComplete = useCallback(async () => {
        if (refs.isSubmitting) return;
        refs.isSubmitting = true;

        console.log("🚀 Checking state sequence...");

        const currentIndex = STATE_SEQUENCE.indexOf(state.currentState);
        if (currentIndex < STATE_SEQUENCE.length - 1) {
            updateState({
                currentState: STATE_SEQUENCE[currentIndex + 1],
                stabilityTime: 0,
            });

            refs.isSubmitting = false;
            return;
        }

        // ✅ Preloaded Face ID
        if (!state.faceId) {
            console.error("❌ Face ID not found");
            toast.error("Ошибка: Face ID не найден");
            refs.isSubmitting = false;
            return;
        }

        const finalData = {
            temperatureData: state.temperatureData,
            alcoholData: state.alcoholData.alcoholLevel ? state.alcoholData : undefined,
            faceId: state.faceId,
        };

        console.log("📡 Sending final data:", finalData);

        // ✅ Show loading toast while sending
        const toastId = toast.loading("Отправка данных...");

        try {
            const response = await fetch(`${process.env.VITE_SERVER_URL}/health`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(finalData),
            });

            if (!response.ok) {
                throw new Error(`❌ Server responded with status: ${response.status}`);
            }

            console.log("✅ Submission successful, navigating to complete authentication...");
            toast.success("Данные успешно отправлены", { id: toastId });

            if (refs.socket) {
                refs.socket.disconnect();
                refs.socket = null;
            }

            navigate("/complete-authentication", { state: { success: true } });

        } catch (error) {
            console.error("❌ Submission error:", error);
            toast.error("Ошибка отправки данных. Проверьте соединение.", { id: toastId });
            refs.isSubmitting = false;
        }
    }, [state, navigate, updateState]);

    return {
        ...state,
        handleComplete,
        setCurrentState: (newState: React.SetStateAction<StateKey>) => {
            updateState({
                currentState:
                    typeof newState === "function" ? newState(state.currentState) : newState,
            });
        },
    };
};
