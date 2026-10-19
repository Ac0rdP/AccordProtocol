---
source_file: docs/guides/connecting-your-wallet.md
source_commit: a22bc7ba98044b716193199db3b62f0124b83b4a
locale: es
status: draft
translators:
  - Accord Documentation Team (machine-assisted)
reviewers: []
notes: Initial draft translation. Machine-assisted; pending native speaker review.
---

# Conectar tu billetera

Esta guía te explica todo lo necesario antes de interactuar con Accord Protocol, desde instalar la extensión de navegador Freighter hasta financiar tu cuenta de prueba. No se requiere experiencia previa en blockchain.

---

## Paso 1 — Instalar la extensión de navegador Freighter

Freighter es una billetera de navegador para Stellar. Te permite crear una cuenta de Stellar, mantener tus claves seguras y firmar transacciones con un solo clic.

**Cómo instalar:**

1. Abre la [página de descarga de Freighter](https://www.freighter.app) en tu navegador.
2. Haz clic en **Add to Chrome** (o el botón equivalente para tu navegador).
3. Tu navegador solicitará confirmación de permisos — haz clic en **Add Extension** para confirmar.

**Cómo verificar que funcionó:** Aparecerá un pequeño ícono de billetera en la barra de extensiones de tu navegador. Haz clic en él y verás la pantalla de bienvenida de Freighter.

---

## Paso 2 — Crear o importar una cuenta de Stellar

Si ya dispones de una cuenta de Stellar que deseas utilizar, puedes importarla. Si eres nuevo en Stellar, crea una cuenta nueva.

**Para crear una cuenta nueva:**

1. Haz clic en el ícono de Freighter en tu barra de extensiones.
2. Haz clic en **Create New Account**.
3. Escribe tu frase de recuperación de 12 palabras y guárdala en un lugar seguro. Esta frase es el único medio para recuperar tu cuenta si pierdes acceso a tu navegador.
4. Confirma la frase cuando se te solicite y define una contraseña para la extensión.

**Para importar una cuenta existente:**

1. Haz clic en el ícono de Freighter y selecciona **Import Account** (o **Import Wallet**).
2. Introduce tu frase de recuperación existente de 12 o 24 palabras.
3. Establece una contraseña cuando se te solicite.

**Cómo verificar que funcionó:** Tras la configuración, la ventana emergente de Freighter mostrará tu dirección de cuenta de Stellar — una cadena larga que comienza con la letra `G`. Esta es tu clave pública.

---

## Paso 3 — Cambiar a la red Testnet

Accord Protocol está desplegado en la red Stellar **Testnet**. Testnet es un entorno aislado para pruebas; los tokens aquí no tienen valor monetario real y los errores no implican pérdida de fondos.

**Cómo cambiar de red:**

1. Haz clic en el ícono de Freighter.
2. Localiza el selector de red en la parte superior de la ventana emergente — por defecto puede mostrar **Mainnet** o **Public Network**.
3. Haz clic en el selector y elige **Testnet** en el menú desplegable.

**Cómo verificar que funcionó:** El selector de red ahora mostrará **Testnet**. Tu dirección de cuenta seguirá siendo la misma — solo cambia la red.

---

## Paso 4 — Financiar tu cuenta con XLM de prueba mediante Friendbot

Las cuentas de Stellar deben mantener un saldo mínimo de XLM para existir en la red y pagar comisiones de transacción. En Testnet puedes obtener XLM de prueba gratuitos mediante **Friendbot**, un grifo (faucet) provisto por la Stellar Development Foundation.

**Cómo financiar tu cuenta:**

1. Copia tu dirección de Stellar desde Freighter (haz clic en la dirección mostrada en la ventana emergente para copiarla).
2. Abre la página de Friendbot en `https://friendbot.stellar.org/?addr=YOUR_ADDRESS` — reemplaza `YOUR_ADDRESS` con la dirección que acabas de copiar — o utiliza el Stellar Laboratory en `https://laboratory.stellar.org/#account-creator?network=test`.
3. Espera unos segundos. Friendbot acreditará 10,000 XLM de prueba en tu cuenta.

**Cómo verificar que funcionó:** Abre Freighter y revisa tu saldo. Deberías ver **10,000 XLM** (Testnet).

---

## Todo listo

Una vez que Freighter refleje tu saldo en Testnet, la aplicación de Accord detectará tu billetera automáticamente al abrirla. No necesitas hacer clic en "conectar" en cada visita — Freighter se reconecta automáticamente al cargar la página siempre que hayas autorizado el sitio previamente.

Ya puedes consultar propuestas, aprobar transferencias e interactuar con el multisig de Accord.
