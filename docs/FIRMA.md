# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

> La solicitud a SignPath Foundation está en trámite. Hasta que la aprueben, los instaladores de Citrus no están firmados.

## Qué se firma

Solo los archivos que GitHub Actions compila desde este repositorio con [`.github/workflows/compilar.yml`](../.github/workflows/compilar.yml):

- `Citrus.exe`, el programa.
- `Citrus-Setup-<versión>.exe`, el instalador.

Las bibliotecas de Electron que trae el instalador son de ese proyecto y no se firman con este certificado. Cada firma se aprueba a mano antes de publicar una versión.

## Equipo

- Autores y revisores: [ManuelOsmaDev](https://github.com/ManuelOsmaDev)
- Aprobadores: [ManuelOsmaDev](https://github.com/ManuelOsmaDev)

Los cambios de otras personas entran solo por pull request, después de la revisión de un miembro del equipo. Todos los miembros usan autenticación de dos factores en GitHub y en SignPath.

## Privacidad

Citrus no tiene cuenta ni servidor propio, y no envía tus colecciones, requests, respuestas ni datos personales a ningún sistema que no hayas configurado tú.

Se conecta solo a:

- Los endpoints, cuentas de AWS y bases de MySQL que configuras en tus colecciones y entornos.
- Los [Releases de este repositorio en GitHub](https://github.com/ManuelOsmaDev/citrus/releases), para buscar actualizaciones al abrirse y cada 6 horas. Esa consulta solo descarga la información de la última versión y, si hay una nueva, el instalador.

## Desinstalar

Citrus se quita desde Configuración de Windows, en Aplicaciones instaladas, o con `Uninstall Citrus.exe` en su carpeta de instalación. Tus colecciones son archivos de tus carpetas y no se borran.
