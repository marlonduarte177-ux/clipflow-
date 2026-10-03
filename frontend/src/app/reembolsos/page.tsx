import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Política de reembolsos · ClipFlow",
  alternates: { languages: { es: "/reembolsos", en: "/en/refunds" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;
const { days, maxMinutesUsed } = LEGAL.refund;

export default function RefundsPage() {
  return (
    <LegalPage
      doc="refunds"
      title="Política de reembolsos"
      intro={
        <p>
          Queremos que pruebes ClipFlow sin riesgo. Si no es para ti, te devolvemos el dinero dentro de los {days} días siguientes al cobro,
          siempre que no hayas procesado más de {maxMinutesUsed} minutos de video desde ese cobro.
        </p>
      }
      sections={[
        {
          title: "Cuándo tienes derecho a reembolso",
          body: (
            <ul>
              <li>Lo pides dentro de los {days} días naturales siguientes al cobro (de la prueba o de una mensualidad).</li>
              <li>Desde ese cobro, has procesado como máximo {maxMinutesUsed} minutos de video.</li>
              <li>Se devuelve el 100 % de ese cobro, por el mismo medio de pago.</li>
            </ul>
          ),
        },
        {
          title: "Cuándo no aplica",
          body: (
            <ul>
              <li>Han pasado más de {days} días desde el cobro.</li>
              <li>Has procesado más de {maxMinutesUsed} minutos de video desde el cobro.</li>
              <li>La cuenta fue suspendida por incumplir los Términos de uso.</li>
            </ul>
          ),
        },
        {
          title: "Si el servicio falla",
          body: (
            <p>
              Si un video no se pudo procesar por un error nuestro, los minutos se devuelven a tu cuenta automáticamente y no cuentan para
              este límite. Si ClipFlow no funcionó y no pudiste usarlo, escríbenos aunque se pase el plazo: lo revisamos caso por caso.
            </p>
          ),
        },
        {
          title: "Cómo pedirlo",
          body: (
            <p>
              Escríbenos a {mail} con el correo de tu cuenta, o responde al recibo de compra que te envió Paddle. Paddle.com es el comerciante
              registrado de nuestros pedidos y es quien hace la devolución. Suele verse en tu cuenta en 5 a 10 días hábiles, según tu banco.
            </p>
          ),
        },
        {
          title: "Cancelar la suscripción",
          body: (
            <p>
              Puedes cancelar cuando quieras para que no se renueve. Cancelar no genera un reembolso automático: conservas el acceso hasta el
              final del período pagado. Si además cumples las condiciones de arriba, puedes pedir el reembolso.
            </p>
          ),
        },
        {
          title: "Derechos del consumidor",
          body: <p>Esta política no limita los derechos que te dé la ley de protección al consumidor de tu país.</p>,
        },
      ]}
    />
  );
}
