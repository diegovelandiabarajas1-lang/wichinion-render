# Wichinion en Render (plan gratuito) — prueba en paralelo

Wichinion es el motor propio de Wichi: habla la misma API que OpenCode 2.x, así que el APK, la PWA, Wichi para PC y la extensión de VS Code lo usan solo cambiando la dirección del servidor.
Este repositorio lo despliega en Render **al lado** del Cowork de OpenCode (que no se toca) para compararlos con clientes reales.

- `Dockerfile`: Node 24 (alpine), usuario sin privilegios, ~60 MB de RAM en reposo. Trae las skills, la ALU y el guardián anti-sueño.
- `render.yaml`: servicio `wichinion-prueba` (gratuito, Virginia). La contraseña la genera Render.
- La clave de NVIDIA **no** está aquí: cada persona la guarda desde su app (queda cifrada en `/data` del servidor).
- Acepta la PWA (`https://diegovelandiabarajas1-lang.github.io`) por CORS: variable `MOTOR_CORS`.

Límites del plan gratuito: se duerme a los 15 min sin tráfico (despierta en ~1 min) y el disco se borra al dormir; las apps llevan su copia de seguridad y vuelven a poner conversaciones, clave y conectores.

Pendiente de comprobar en Render: copia/restauración tras un reinicio real, guardián con una tarea larga (más de 15 min) y generación de imágenes (el script lee la clave de `/root/.wichi/nvidia.key`, que Wichinion no deja escribir fuera de `/workspace` y `/data`).
