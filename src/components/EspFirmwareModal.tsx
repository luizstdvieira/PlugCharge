import React, { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

const SERVER_IP = '192.168.137.1';

interface EspFirmwareModalProps {
  open: boolean;
  onClose: () => void;
}

export function EspFirmwareModal({
  open,
  onClose,
}: EspFirmwareModalProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [serverUrl, setServerUrl] = useState(`http://${SERVER_IP}:3000`);

  if (!open) return null;

  const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '');
  let serverHostname = '';
  let isServerUrlValid = false;
  try {
    const parsedUrl = new URL(normalizedServerUrl);
    serverHostname = parsedUrl.hostname;
    isServerUrlValid = parsedUrl.protocol === 'http:';
  } catch {
    isServerUrlValid = false;
  }

  const isLocalServer = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(
    serverHostname
  );
  const canCopy =
    wifiSsid.trim().length > 0 &&
    wifiPassword.length > 0 &&
    isServerUrlValid &&
    !isLocalServer;

  const firmwareCode = `// Plug&Charge — ESP32-S3, LCD 16x2 e sensor HC-SR04
// Bibliotecas: ArduinoJson v7 e LiquidCrystal_I2C
// HC-SR04 ECHO deve passar por divisor de tensao para 3,3 V antes do GPIO.

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

const char* WIFI_SSID = ${JSON.stringify(wifiSsid.trim())};
const char* WIFI_PASS = ${JSON.stringify(wifiPassword)};
const char* SERVER_URL = ${JSON.stringify(normalizedServerUrl)};
const char* DEVICE_ID = "ESP32-S3-TOTEM-01";

const uint8_t PIN_TRIG = 5;
const uint8_t PIN_ECHO = 6;
const float DETECTION_DISTANCE_CM = 25.0;

LiquidCrystal_I2C lcd(0x27, 16, 2);

long lastCommandSeq = 0;
bool chargingActive = false;
bool serverContactLogged = false;
volatile bool wifiDisconnectedEvent = false;
unsigned long lastPollMs = 0;
unsigned long lastWifiAttemptMs = 0;
float distanceCm = 999.0;

void writeLcdLine(uint8_t row, String text) {
  text = text.substring(0, 16);
  while (text.length() < 16) text += ' ';
  lcd.setCursor(0, row);
  lcd.print(text);
}

void updateLcd(String line1, String line2) {
  writeLcdLine(0, line1);
  writeLcdLine(1, line2);
}

void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    wifiDisconnectedEvent = false;
    Serial.print("Wi-Fi conectado. IP da ESP32: ");
    Serial.println(WiFi.localIP());
  } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    wifiDisconnectedEvent = true;
    Serial.print("Wi-Fi desconectado. Motivo ESP-IDF: ");
    Serial.println(info.wifi_sta_disconnected.reason);
  }
}

void scanConfiguredNetwork() {
  Serial.print("Buscando a rede configurada: ");
  Serial.println(WIFI_SSID);
  const int networkCount = WiFi.scanNetworks(false, true);
  bool networkFound = false;

  if (networkCount < 0) {
    Serial.print("Falha na busca de redes Wi-Fi. Codigo: ");
    Serial.println(networkCount);
    return;
  }

  for (int i = 0; i < networkCount; i++) {
    if (WiFi.SSID(i) == String(WIFI_SSID)) {
      networkFound = true;
      Serial.print("Rede encontrada. Canal: ");
      Serial.print(WiFi.channel(i));
      Serial.print(", sinal: ");
      Serial.print(WiFi.RSSI(i));
      Serial.println(" dBm.");
      break;
    }
  }

  if (!networkFound) {
    Serial.println("SSID configurado nao apareceu na busca.");
  }
  WiFi.scanDelete();
}

bool connectWifi() {
  lastWifiAttemptMs = millis();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  scanConfiguredNetwork();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  updateLcd("Conectando WiFi", "Aguarde...");
  Serial.print("Conectando ao Wi-Fi: ");
  Serial.println(WIFI_SSID);

  const unsigned long startMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startMs < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.print("Falha no Wi-Fi. status=");
    Serial.println(static_cast<int>(WiFi.status()));
    updateLcd("Falha no WiFi", "Monitor Serial");
    return false;
  }

  updateLcd("WiFi conectado", "Aguard. servidor");
  return true;
}

float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  const unsigned long duration = pulseIn(PIN_ECHO, HIGH, 30000UL);
  if (duration == 0) return 999.0;
  return duration * 0.0343 / 2.0;
}

void pollCommand() {
  HTTPClient http;
  http.setTimeout(3000);
  const String url = String(SERVER_URL) +
    "/api/esp/command?deviceId=" + DEVICE_ID;

  if (!http.begin(url)) {
    Serial.println("Nao foi possivel iniciar HTTP para consultar comandos.");
    return;
  }

  const int code = http.GET();
  if (code != 200) {
    serverContactLogged = false;
    Serial.print("Falha ao consultar servidor. HTTP ");
    Serial.println(code);
    http.end();
    return;
  }

  if (!serverContactLogged) {
    Serial.println("Conectado ao servidor Plug&Charge (HTTP 200).");
    serverContactLogged = true;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, http.getString());
  http.end();
  if (error) {
    Serial.print("Resposta JSON invalida: ");
    Serial.println(error.c_str());
    return;
  }

  const long seq = doc["commandSeq"] | 0L;
  const char* command = doc["command"] | "NONE";
  if (seq == lastCommandSeq) return;
  lastCommandSeq = seq;

  if (strcmp(command, "START_CHARGING") == 0) {
    chargingActive = true;
  } else if (
    strcmp(command, "STOP_CHARGING") == 0 ||
    strcmp(command, "RESET") == 0
  ) {
    chargingActive = false;
  }
}

void sendTelemetry() {
  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(String(SERVER_URL) + "/api/esp/telemetry")) {
    Serial.println("Nao foi possivel iniciar HTTP para enviar sensor.");
    return;
  }
  http.addHeader("Content-Type", "application/json");

  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["sensorMode"] = "HC_SR04";
  doc["distanceCm"] = distanceCm;
  if (chargingActive) {
    doc["status"] = "CARREGANDO";
    doc["lcdLine1"] = "Carregando";
    doc["lcdLine2"] = "Inducao Ativa";
  }

  String body;
  serializeJson(doc, body);
  const int code = http.POST(body);
  if (code != 200) {
    Serial.print("Falha ao enviar sensor. HTTP ");
    Serial.println(code);
  }
  http.end();
}

void updateStatusLcd() {
  if (chargingActive) {
    updateLcd("Carregando", "Inducao Ativa");
  } else if (distanceCm <= DETECTION_DISTANCE_CM) {
    updateLcd("Carro detectado", "Dist: " + String(distanceCm, 1) + " cm");
  } else {
    updateLcd("Totem pronto", "Aproxime veiculo");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);

  Wire.begin(8, 9);
  lcd.init();
  lcd.backlight();
  updateLcd("Iniciando", "Plug&Charge");
  WiFi.onEvent(onWiFiEvent);
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    serverContactLogged = false;
    if (
      wifiDisconnectedEvent &&
      millis() - lastWifiAttemptMs >= 10000
    ) {
      wifiDisconnectedEvent = false;
      lastWifiAttemptMs = millis();
      Serial.println("Tentando conectar novamente apos desconexao...");
      if (!WiFi.reconnect()) {
        Serial.println("WiFi.reconnect() nao iniciou a tentativa.");
      }
    }
    delay(250);
    return;
  }

  if (millis() - lastPollMs < 1000) return;
  lastPollMs = millis();

  distanceCm = readDistanceCm();
  pollCommand();
  sendTelemetry();
  updateStatusLcd();
}`;

  const handleCopy = async () => {
    setCopyError(null);
    const copyWithFallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = firmwareCode;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      try {
        textarea.select();
        if (!document.execCommand('copy')) {
          throw new Error('Clipboard copy was rejected.');
        }
      } finally {
        textarea.remove();
      }
    };

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(firmwareCode);
      } else {
        copyWithFallback();
      }
    } catch {
      try {
        copyWithFallback();
      } catch {
        setCopyError(
          'Não foi possível copiar automaticamente. Selecione e copie o código manualmente.'
        );
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="firmware-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden shadow-xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2
              id="firmware-modal-title"
              className="text-base font-semibold text-slate-900"
            >
              Código Firmware ESP32-S3 (Arduino C++)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Endpoints pré-configurados para {normalizedServerUrl}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={!canCopy}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copiado
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copiar Código
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-b border-slate-200 space-y-3">
          <p className="text-sm font-medium text-slate-900">
            Conexão entre o site e a ESP32-S3
          </p>
          <p className="text-xs text-slate-600">
            No Windows, ative Hotspot móvel e compartilhe a conexão Ethernet
            por Wi-Fi. Configure um nome e uma senha para o hotspot e use-os
            abaixo. A ESP32-S3 precisa de Wi-Fi de 2,4 GHz.
          </p>
          <p className="text-xs text-slate-600">
            O endereço do servidor deve ser o IPv4 do adaptador do Hotspot
            Móvel (em geral, 192.168.137.1), não o IP Ethernet do notebook.
            Confirme com ipconfig depois de ativar o hotspot. Permita também
            conexões de entrada do Node.js na porta 3000 pelo firewall.
          </p>
          <p className="text-xs text-slate-600">
            Este firmware não controla relé. Ligue TRIG ao GPIO 5 e ECHO ao GPIO
            6 com divisor de tensão para 3,3 V; o LCD usa SDA 8 e SCL 9.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-slate-700">
              Nome do Wi-Fi (SSID)
              <input
                type="text"
                autoComplete="off"
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700">
              Senha do Wi-Fi
              <input
                type="password"
                autoComplete="new-password"
                value={wifiPassword}
                onChange={(event) => setWifiPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
              />
            </label>
          </div>
          <label className="block text-xs font-medium text-slate-700">
            Endereço estável do servidor acessível pela ESP32
            <input
              type="url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder={`http://${SERVER_IP}:3000`}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
            />
          </label>
          {isLocalServer ? (
            <p className="text-xs text-amber-800">
              Não use localhost nem 0.0.0.0. Informe o IPv4 do computador na
              rede do hotspot, por exemplo http://192.168.137.1:3000.
            </p>
          ) : !isServerUrlValid ? (
            <p className="text-xs text-amber-800">
              Informe o endereço local do servidor começando com http://.
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              O computador e a ESP32 ficam na mesma rede do hotspot. Se o IPv4
              do adaptador mudar, atualize este endereço antes de copiar o firmware.
            </p>
          )}
          {copyError && <p className="text-xs text-red-700">{copyError}</p>}
        </div>

        <div className="p-6 overflow-y-auto bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed">
          <pre className="whitespace-pre-wrap break-words">{firmwareCode}</pre>
        </div>
      </div>
    </div>
  );
}
