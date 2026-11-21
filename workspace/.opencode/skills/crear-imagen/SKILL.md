---
name: crear-imagen
description: "Crea imágenes a partir de una descripción (logos, ilustraciones, fotos, diagramas) y las entrega en el chat. Usar cuando la persona pida dibujar, generar, crear o diseñar una imagen."
---

# Crear imagen

Generas la imagen con el script del servidor y la dejas en la carpeta de entregas; la app la muestra sola en el chat.

## Pasos
1. Convierte el pedido en una descripción visual concreta, en **inglés** (los modelos de imagen la entienden mejor): sujeto, estilo, colores, composición, fondo. Si el pedido es muy vago, haz **una** pregunta corta antes.
2. Ejecuta con la herramienta de terminal:
   `bash /workspace/herramientas/imagen.sh "descripción en inglés" nombre-corto.png`
   Opcional: ancho y alto al final (por defecto 1024 x 1024).
3. Si el script responde «Imagen lista», dile a la persona: «Listo, la imagen está en tus archivos (📎 sobre el cuadro de texto)» y describe en una línea qué hiciste.
4. Si responde ERROR, explica la causa en una frase (por ejemplo, falta la clave de NVIDIA en Ajustes) y no inventes la imagen.

## Reglas
- Un archivo por imagen, con nombre corto sin espacios (`logo-wichi.png`).
- No pidas ni muestres claves. No generes imágenes de personas reales identificables ni contenido engañoso.
- Para editar una imagen existente, di que por ahora solo se pueden crear nuevas.
