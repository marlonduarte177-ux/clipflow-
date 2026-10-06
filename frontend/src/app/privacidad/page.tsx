import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Política de privacidad · ClipFlow",
  alternates: { languages: { es: "/privacidad", en: "/en/privacy" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;

export default function PrivacyPage() {
  return (
    <LegalPage
      doc="privacy"
      title="Política de privacidad"
      intro={
        <p>
          Esta política explica qué datos recoge ClipFlow ({LEGAL.site}), para qué los usa y qué derechos tienes. El responsable es{" "}
          {LEGAL.owner}, {LEGAL.country}. Contacto: {mail}.
        </p>
      }
      sections={[
        {
          title: "Qué datos recogemos",
          body: (
            <ul>
              <li>
                <strong>Cuenta:</strong> tu correo electrónico y tu contraseña (guardada cifrada; nunca la vemos).
              </li>
              <li>
                <strong>Tu contenido:</strong> los videos que subes o importas por enlace, los enlaces que pegas, los clips generados, las
                transcripciones y los subtítulos.
              </li>
              <li>
                <strong>Uso del servicio:</strong> qué videos procesaste, su duración, los minutos usados y registros técnicos (por ejemplo,
                errores) para mantener el servicio.
              </li>
              <li>
                <strong>Pagos:</strong> los gestiona Paddle. Nosotros no recibimos ni guardamos los datos de tu tarjeta; solo sabemos tu plan y
                si el pago se realizó.
              </li>
            </ul>
          ),
        },
        {
          title: "Para qué los usamos",
          body: (
            <ul>
              <li>Prestarte el servicio: guardar tus videos, analizarlos y generar tus clips.</li>
              <li>Gestionar tu cuenta, tu plan y tus minutos.</li>
              <li>Darte soporte y avisarte de cambios importantes.</li>
              <li>Mantener el servicio seguro y evitar abusos.</li>
            </ul>
          ),
        },
        {
          title: "Lo que no hacemos",
          body: (
            <ul>
              <li>No vendemos tus datos ni los compartimos con anunciantes.</li>
              <li>No publicamos tus videos ni los usamos para entrenar modelos de inteligencia artificial.</li>
              <li>No usamos cookies de publicidad ni de seguimiento. Solo usamos las cookies necesarias para mantener tu sesión iniciada.</li>
            </ul>
          ),
        },
        {
          title: "Con quién compartimos datos",
          body: (
            <>
              <p>Solo con proveedores que necesitamos para prestar el servicio, y solo lo necesario:</p>
              <ul>
                <li>
                  <strong>Amazon Web Services (AWS):</strong> aloja la app, la base de datos y tus archivos, en servidores de Estados Unidos.
                </li>
                <li>
                  <strong>AssemblyAI:</strong> recibe el audio de tus videos para transcribirlo. Al terminar, borramos la transcripción de
                  su servicio.
                </li>
                <li>
                  <strong>OpenAI:</strong> recibe el texto de la transcripción para elegir los mejores momentos y proponer títulos. Según
                  sus condiciones para empresas, no usa estos datos para entrenar sus modelos.
                </li>
                <li>
                  <strong>Paddle:</strong> procesa los pagos como comerciante registrado.
                </li>
                <li>
                  <strong>Proveedor de red para importar enlaces:</strong> cuando una plataforma bloquea la importación desde nuestros
                  servidores, el video se pide a través de un intermediario de red, que solo ve el enlace.
                </li>
              </ul>
              <p>También podemos entregar datos si una autoridad competente lo exige por ley.</p>
            </>
          ),
        },
        {
          title: "Cuánto tiempo los guardamos",
          body: (
            <ul>
              <li>Tus videos, clips y transcripciones: hasta que los borres o elimines tu cuenta.</li>
              <li>Las copias de seguridad de la base de datos se borran solas a los 7 días; los registros técnicos, a los 30 días.</li>
              <li>
                Los registros de pagos y de minutos se conservan el tiempo que exige la ley, separados de tu correo cuando eliminas la cuenta.
              </li>
            </ul>
          ),
        },
        {
          title: "Tus derechos",
          body: (
            <>
              <p>
                De acuerdo con la Ley de Protección de la Persona frente al Tratamiento de sus Datos Personales (Ley 8968 de {LEGAL.country}) y
                otras leyes aplicables, puedes:
              </p>
              <ul>
                <li>Acceder a tus datos y pedir una copia.</li>
                <li>Corregirlos si son incorrectos.</li>
                <li>Eliminarlos: puedes borrar videos o tu cuenta completa desde la app, o pedírnoslo.</li>
                <li>Oponerte a un uso concreto o retirar tu consentimiento.</li>
              </ul>
              <p>Escríbenos a {mail}; respondemos en un máximo de 10 días hábiles.</p>
            </>
          ),
        },
        {
          title: "Seguridad",
          body: (
            <p>
              Tus datos viajan cifrados (HTTPS) y se guardan cifrados. Solo nuestro sistema accede a tus archivos, con enlaces temporales que
              caducan en minutos.
            </p>
          ),
        },
        {
          title: "Menores de edad",
          body: <p>ClipFlow no está dirigido a menores de 18 años y no recogemos datos de menores a sabiendas.</p>,
        },
        {
          title: "Cambios en esta política",
          body: <p>Si la cambiamos de forma importante, te avisaremos en la app o por correo antes de que se aplique.</p>,
        },
      ]}
    />
  );
}
