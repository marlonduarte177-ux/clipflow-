# Archivos de prueba

- `nasa-crew.jpg`: retrato oficial de la tripulación de la Expedición 59 de la Estación Espacial
  Internacional (NASA ID `iss059-s-002`, crédito NASA/Robert Markowitz), recortado a 16:9 y
  reducido. Las imágenes de la NASA son de dominio público. Se usa para probar el detector de caras
  (6 personas en fila).

- `yamnet-chirp.json`: resultado del YAMNet ORIGINAL (TensorFlow 2.15, pesos oficiales) con una señal
  sintética (barrido de tono + tono de 1 kHz desde el segundo 1,5): fila y columna del espectrograma
  log-mel y puntajes de las 5 clases más fuertes. El test del detector de sonidos genera la misma señal y
  comprueba que el cálculo en TypeScript + ONNX da lo mismo.

# Modelos

- `../models/face_detection_yunet_2023mar.onnx`: detector de caras YuNet de
  [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
  (licencia MIT). SHA-256:
  `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.
- `../models/yamnet.onnx`: detector de sonidos YAMNet de Google
  ([tensorflow/models, research/audioset/yamnet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet),
  licencia Apache 2.0). Es el núcleo de la red (parches log-mel `[n, 96, 64]` → puntajes `[n, 521]`),
  convertido con tf2onnx 1.16.1 (opset 13) desde los pesos oficiales `yamnet.h5`
  (SHA-256 `13c3308955bbfaef262f175ac9c40e47b134573a93984f009220dd7cc12a1744`). Diferencia máxima con
  TensorFlow: 8e-7. SHA-256 del ONNX:
  `ae3b378f23babf77acf6acdf18082a220a59a73ff565b7c1dd9b845565242852`.
