import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServiceAuthUsuario } from "@/lib/auth/get-service-auth-usuario";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";

function emailExistsInAuthError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("already been registered") ||
    m.includes("already registered") ||
    m.includes("user already registered") ||
    m.includes("duplicate")
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findAuthUserIdByEmail(supabase: any, email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  let page = 1;
  while (true) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 500 });
    const users = data?.users ?? [];
    const found = users.find((u: { id: string; email?: string }) => (u.email ?? "").toLowerCase() === target);
    if (found) return found.id;
    if (users.length < 500) break;
    page++;
  }
  return null;
}

/**
 * Crea usuario en Auth + `zentra_erp.usuarios`, o si el correo ya existe en Auth,
 * vincula ese usuario a la empresa del administrador (útil tras pruebas u otra empresa).
 */
export async function POST(req: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const authR = await getServiceAuthUsuario(req);
    if (!authR.ok) {
      return NextResponse.json({ error: "No autenticado" }, { status: authR.status });
    }
    if (!authR.catalogUsuario) {
      return NextResponse.json({ error: "Perfil no encontrado" }, { status: 403 });
    }

    const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });

    const admin = {
      empresa_id: authR.catalogUsuario.empresa_id ?? undefined,
      rol: authR.catalogUsuario.rol ?? undefined,
    };

    if (!admin.empresa_id && admin.rol !== "super_admin") {
      return NextResponse.json({ error: "Tu usuario no tiene empresa asignada." }, { status: 403 });
    }

    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const nombre = String(body.nombre ?? "").trim();
    const telefono = body.telefono ? String(body.telefono).trim() : null;
    const fecha_nacimiento = body.fecha_nacimiento ? String(body.fecha_nacimiento) : null;
    const fecha_ingreso = body.fecha_ingreso ? String(body.fecha_ingreso) : null;
    const tipoRaw = body.tipo_contrato ? String(body.tipo_contrato).trim().toLowerCase() : null;
    const tipoOk = ["salario", "comision", "mixto", "prestador_servicio"];
    const tipo_contrato = tipoRaw && tipoOk.includes(tipoRaw) ? tipoRaw : null;
    const parseGs = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v).replace(/\./g, "").replace(/\s/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const parsePct = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v));
      return Number.isFinite(n) ? n : null;
    };
    const salario_base = parseGs(body.salario_base);
    const porcentaje_comision = parsePct(body.porcentaje_comision);
    const ips = Boolean(body.ips);
    const areaRaw = body.area ? String(body.area).trim().toLowerCase() : null;
    const areasOk = ["ventas", "soporte", "finanzas", "operaciones", "administracion"];
    const area = areaRaw && areasOk.includes(areaRaw) ? areaRaw : null;
    const rol = String(body.rol ?? "usuario");

    if (!email || !password || password.length < 6) {
      return NextResponse.json({ error: "Email y contraseña (mín. 6 caracteres) son obligatorios." }, { status: 400 });
    }
    if (!nombre) {
      return NextResponse.json({ error: "El nombre es obligatorio." }, { status: 400 });
    }

    if (porcentaje_comision != null && (porcentaje_comision < 0 || porcentaje_comision > 100)) {
      return NextResponse.json({ error: "La comisión debe estar entre 0 y 100." }, { status: 400 });
    }

    const empresaId = admin.empresa_id;
    if (!empresaId) {
      return NextResponse.json({ error: "Solo un administrador de empresa puede crear usuarios." }, { status: 403 });
    }

    let authUserId: string | null = null;
    let vinculado = false;

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr) {
      if (emailExistsInAuthError(createErr.message)) {
        authUserId = await findAuthUserIdByEmail(supabase, email);
        if (!authUserId) {
          return NextResponse.json(
            {
              error:
                "El correo figura como ocupado en Auth pero no se pudo localizar el usuario. Revisá en Supabase → Authentication → Users o esperá unos minutos y reintentá.",
            },
            { status: 400 }
          );
        }
        vinculado = true;
        await supabase.auth.admin.updateUserById(authUserId, { password });
      } else {
        return NextResponse.json({ error: createErr.message }, { status: 400 });
      }
    } else {
      authUserId = created.user?.id ?? null;
    }

    const { data: existente } = await supabase
      .from("usuarios")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    const payload = {
      empresa_id: empresaId,
      email,
      nombre,
      telefono,
      fecha_nacimiento,
      fecha_ingreso,
      tipo_contrato,
      salario_base,
      porcentaje_comision,
      ips,
      area,
      rol,
      auth_user_id: authUserId,
      estado: "activo" as const,
    };

    let targetId: string;

    if (existente?.id) {
      const { error: upErr } = await supabase.from("usuarios").update(payload).eq("id", existente.id);
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });
      targetId = existente.id;
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from("usuarios")
        .insert([payload])
        .select("id")
        .single();
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
      if (!inserted?.id) {
        return NextResponse.json({ error: "No se pudo obtener el id del usuario creado." }, { status: 500 });
      }
      targetId = inserted.id as string;
    }

    await supabase.from("usuario_modulos").delete().eq("usuario_id", targetId);
    if (!esRolAdminEmpresa(rol)) {
      const { data: emActivos } = await supabase
        .from("empresa_modulos")
        .select("modulo_id")
        .eq("empresa_id", empresaId)
        .eq("activo", true);

      /**
       * Antes se asignaban TODOS los módulos activos de la empresa a cualquier usuario no-admin,
       * así que un usuario nacía viendo el ERP entero y había que recortarlo después. Ahora, si
       * el alta manda `modulo_ids`, se otorgan solo esos (intersecados con los de la empresa,
       * para que el body no pueda pedir un módulo que la empresa no tiene). Sin `modulo_ids` se
       * mantiene el comportamiento anterior, para no romper las altas existentes.
       */
      const empresaIds = new Set(
        (emActivos ?? []).map((r) => String(r.modulo_id ?? "")).filter(Boolean)
      );
      const rawModuloIds: unknown = (body as { modulo_ids?: unknown }).modulo_ids;
      const pedidos: string[] | null = Array.isArray(rawModuloIds)
        ? [...new Set(rawModuloIds.map((x) => String(x ?? "")).filter((v) => v.length > 0))]
        : null;
      const seleccion =
        pedidos !== null
          ? pedidos.filter((id) => empresaIds.has(id)).map((id) => ({ modulo_id: id }))
          : (emActivos ?? []);

      if (pedidos !== null && seleccion.length === 0) {
        return NextResponse.json(
          { error: "Ninguno de los módulos indicados está habilitado para la empresa." },
          { status: 400 }
        );
      }

      const emSeleccion = seleccion;
      if (emSeleccion && emSeleccion.length > 0) {
        const umRows = emSeleccion.map((r) => ({
          usuario_id: targetId,
          modulo_id: r.modulo_id as string,
        }));
        const { error: errUm } = await supabase.from("usuario_modulos").insert(umRows);
        if (errUm) {
          return NextResponse.json(
            { error: `Usuario guardado pero error al asignar módulos: ${errUm.message}` },
            { status: 400 }
          );
        }
      }
    }

    return NextResponse.json({
      success: true,
      vinculado,
      message: vinculado
        ? "Ese correo ya existía en el sistema. Se actualizó la contraseña y se asignó a tu empresa."
        : "Usuario creado correctamente.",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
