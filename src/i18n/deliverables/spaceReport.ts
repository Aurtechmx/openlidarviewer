/**
 * spaceReport.ts: the words of the space and object report in each export
 * language.
 *
 * English is the source. Its entries are exactly the text the report printed
 * before it had a catalog, and a test holds the English report to frozen
 * digests. Sentences other modules own (the not-survey-grade note, the
 * panel's object hints) are imported, not copied, so there is one wording. The other languages are typed against the English keys, so a missing
 * entry fails the build, and a parity test checks every entry uses the same
 * `{parameters}`. They are drafts until a geomatics reviewer signs them off
 * (`reviewed` in languages.ts); until then the report says so in its footer.
 *
 * Numbers reach these templates already written in the export's number style.
 * Text the report copies from the scan (its name, a truncation note) is not
 * translated.
 */
import type { ExportLanguage } from '../languages';
import { NOT_SURVEY_GRADE_NOTE } from '../../terrain/export/exportNotes';
import {
  ANGULAR_COVERAGE_HINT,
  ANGULAR_COVERAGE_LABEL,
  OBJECT_ENVELOPE_VOLUME_HINT,
  OBJECT_ORIENTED_UNVALIDATED_HINT,
  OBJECT_SURFACE_AREA_HINT,
} from '../../terrain/objectMetrics';

const EN = {
  scanInterior: 'Interior space',
  scanObject: 'Object',
  untitled: 'Untitled scan',
  unknown: 'unknown',

  secDimensions: 'Dimensions',
  secPlanes: 'Planes',
  secCapture: 'Capture quality',
  secMeasurements: 'Measurements',

  lxwxh: 'L x W x H',
  footprint: 'Footprint area',
  ceilingHeight: 'Ceiling height',
  enclosedVolume: 'Enclosed volume',
  storeys: 'Storeys / levels',
  floor: 'Floor',
  ceiling: 'Ceiling',
  walls: 'Walls',
  oriented: 'Oriented (L x W x H)',
  axisAligned: 'Axis-aligned (L x W x H)',
  largest: 'Largest dimension (unvalidated)',
  envelopeVolume: 'Envelope volume',
  boundingSurface: 'Bounding surface area',
  angularCoverage: ANGULAR_COVERAGE_LABEL,
  points: 'Points (measured / loaded)',
  density: 'Density',
  spacing: 'Mean spacing',
  boundingFilled: 'Bounding area filled',
  colour: 'Colour (RGB)',
  status: 'Status',

  present: 'Present  {area}',
  notDetected: 'Not detected',
  wallsValue: '{pct}% coverage / ~{n} direction(s)',
  pointsValue: '{measured} measured / {loaded} loaded',
  yes: 'Yes',
  no: 'No',
  angularValue: '{pct}% of directions about the centroid',
  noMeasurements: 'No measurements available yet.',
  percent: '{pct}%',

  hintLargest: OBJECT_ORIENTED_UNVALIDATED_HINT,
  hintEnvelopeVolume: OBJECT_ENVELOPE_VOLUME_HINT,
  hintBoundingSurface: OBJECT_SURFACE_AREA_HINT,
  hintAngular: ANGULAR_COVERAGE_HINT,

  sourceUnits: '(source units)',
  sourceUnitsSq: '(square source units)',
  sourceUnitsCu: '(cubic source units)',
  densityMetric: '{v} pts/m²',
  densitySource: '{v} pts per square source unit',

  unitsUnknown: 'source units (scale unverified — not asserted as metres)',
  unitsMetres: 'metres',
  unitsFeet: 'feet (source) → metres',
  unitsFactor: 'source units × {f} → metres',

  kSoftware: 'Software',
  kMetricVersion: 'Metric version',
  kGenerated: 'Generated',
  kSource: 'Source',
  kScanType: 'Scan type',
  kUnits: 'Units',
  kPoints: 'Points',
  kCoverage: 'Coverage',
  kNote: 'Note',
  kEvidence: 'Evidence',
  kLanguage: 'Language',
  pointsLine: '{measured} measured / {loaded} loaded in viewer',
  coverageLine: '{coverage}. Figures are from the points read.',
  languageDraft: '{name} (translation not yet reviewed)',

  notSurveyGrade: NOT_SURVEY_GRADE_NOTE,
  evidence:
    'Unvalidated envelope estimate. The areas, volumes, angular ' +
    'coverage and density here are bounding-envelope and grid estimates from the ' +
    'loaded point sample. No registered claim covers them, so they carry no ' +
    'cross-implementation and no field validation. Do not present this as a ' +
    'validated deliverable.',

  noteStream: 'Based on the points loaded in the viewer.',
  noteStreamPartial:
    'Preliminary — only the streamed-in part of the scan has been measured so far; dimensions, areas and volumes will change as more loads. Let the full cloud stream in, then re-run.',
  noteUnitUnverified:
    'Coordinate units are unverified, so dimensions, areas, volumes and densities are reported in the source file\'s own units, not in metres. Confirm the source CRS to state them in metres.',
  noteTooFewPoints: 'Too few points to measure this space yet.',
  noteStrayExcluded:
    '{count} stray return(s) outside the dense footprint were excluded — dimensions describe the scanned space, matching the floor-plan sheet.',
  noteDensityScaled:
    'Density and spacing are scaled from a {measured}-point measured subset ' +
    'to the {loaded}-point loaded sample ' +
    '(uniform-stride assumption). The loaded sample is what the viewer holds, ' +
    'which may itself be a subset of the file.',
  noteCeilingApproximate: 'Ceilings are often sparsely captured — ceiling height and enclosed volume are approximate.',
  noteCeilingMissing: 'No clear ceiling captured yet — height and volume are unavailable until the top surface is scanned.',
  noteWallsEstimate: 'Wall and plane figures are pragmatic estimates, not a certified survey.',
  noteOpenObject: 'Open object — enclosed volume is a bounding-box envelope, not a solid measurement.',

  planTitle: 'Floor plan preview (walls traced from the scan)',
  notesTitle: 'Notes',
  provenanceTitle: 'Provenance',
  continued: ' (continued)',
  roomImperial: 'Room {i} {area} sq ft',
  roomMetric: 'Room {i} {area} m2',
  planDimsImperial: 'W {w} ft ({wAlt} m) x D {d} ft ({dAlt} m)',
  planDimsMetric: 'W {w} m ({wAlt} ft) x D {d} m ({dAlt} ft)',
  planCaptionGraph:
    'Experimental preview - wall-graph reconstruction from the scan, not a measured floor plan; requires visual validation.',
  planCaptionTrace:
    'Experimental preview - walls traced from the scan, not a measured floor plan; requires visual validation.',
} as const;

export type SpaceReportKey = keyof typeof EN;
type Catalog = Readonly<Record<SpaceReportKey, string>>;

const ES: Catalog = {
  scanInterior: 'Espacio interior',
  scanObject: 'Objeto',
  untitled: 'Escaneo sin título',
  unknown: 'desconocido',

  secDimensions: 'Dimensiones',
  secPlanes: 'Superficies planas',
  secCapture: 'Calidad de captura',
  secMeasurements: 'Mediciones',

  lxwxh: 'L x A x H',
  footprint: 'Área ocupada en planta',
  ceilingHeight: 'Altura de piso a techo',
  enclosedVolume: 'Volumen encerrado',
  storeys: 'Niveles',
  floor: 'Piso',
  ceiling: 'Techo',
  walls: 'Muros',
  oriented: 'Orientada (L x A x H)',
  axisAligned: 'Alineada a los ejes (L x A x H)',
  largest: 'Dimensión mayor (sin validar)',
  envelopeVolume: 'Volumen de la envolvente',
  boundingSurface: 'Área de la superficie envolvente',
  angularCoverage: 'Cobertura angular',
  points: 'Puntos (medidos / cargados)',
  density: 'Densidad',
  spacing: 'Separación media',
  boundingFilled: 'Área ocupada del rectángulo envolvente',
  colour: 'Color (RGB)',
  status: 'Estado',

  present: 'Presente  {area}',
  notDetected: 'No detectado',
  wallsValue: '{pct}% de cobertura / ~{n} dirección(es)',
  pointsValue: '{measured} medidos / {loaded} cargados',
  yes: 'Sí',
  no: 'No',
  angularValue: '{pct}% de las direcciones alrededor del centroide',
  noMeasurements: 'Todavía no hay mediciones disponibles.',
  percent: '{pct}%',

  hintLargest:
    'Lado más largo de la caja orientada, la cifra principal de tamaño. La caja se ajusta '
    + 'por ejes principales, que tienden a la diagonal en conjuntos de puntos planos o '
    + 'simétricos, así que tómela como una estimación sin validar y no como una extensión medida.',
  hintEnvelopeVolume: 'Envolvente: no es un volumen sólido. Una nube de puntos no tiene un interior cerrado.',
  hintBoundingSurface:
    'Área de la superficie de la caja envolvente (aproximada): la piel de la envolvente, '
    + 'no la superficie real (malla) del objeto.',
  hintAngular:
    'Proporción de los intervalos de dirección alrededor del centroide del conjunto de puntos que tienen '
    + 'retornos. Sigue la forma del escaneo: una superficie plana o laminar llena solo parte '
    + 'de la esfera, por completa que sea su captura.',

  sourceUnits: '(unidades de origen)',
  sourceUnitsSq: '(unidades de origen al cuadrado)',
  sourceUnitsCu: '(unidades de origen al cubo)',
  densityMetric: '{v} pts/m²',
  densitySource: '{v} pts por unidad de origen al cuadrado',

  unitsUnknown: 'unidades de origen (escala sin verificar, no se afirma que sean metros)',
  unitsMetres: 'metros',
  unitsFeet: 'pies (origen) → metros',
  unitsFactor: 'unidades de origen × {f} → metros',

  kSoftware: 'Software',
  kMetricVersion: 'Versión de métricas',
  kGenerated: 'Generado',
  kSource: 'Origen',
  kScanType: 'Tipo de escaneo',
  kUnits: 'Unidades',
  kPoints: 'Puntos',
  kCoverage: 'Cobertura',
  kNote: 'Nota',
  kEvidence: 'Evidencia',
  kLanguage: 'Idioma',
  pointsLine: '{measured} medidos / {loaded} cargados en el visor',
  coverageLine: '{coverage}. Las cifras provienen de los puntos leídos.',
  languageDraft: '{name} (traducción pendiente de revisión)',

  notSurveyGrade: 'Aptitud: no tiene calidad topográfica salvo que se valide contra puntos de control en campo.',
  evidence:
    'Estimación de envolvente sin validar. Las áreas, los volúmenes, la cobertura angular y la '
    + 'densidad de este informe son estimaciones de envolvente y de cuadrícula a partir de la muestra de puntos '
    + 'cargada. Ninguna afirmación registrada las cubre, así que no tienen validación cruzada '
    + 'entre implementaciones ni validación en campo. No presente este documento como un '
    + 'entregable validado.',

  noteStream: 'Basado en los puntos cargados en el visor.',
  noteStreamPartial:
    'Preliminar: hasta ahora solo se ha medido la parte del escaneo ya transmitida; las dimensiones, '
    + 'áreas y volúmenes cambiarán al cargar más. Deje que se transmita la nube completa y vuelva a calcular.',
  noteUnitUnverified:
    'Las unidades de las coordenadas no están verificadas, así que dimensiones, áreas, volúmenes y '
    + 'densidades se dan en las unidades propias del archivo, no en metros. Confirme el SRC '
    + 'de origen para expresarlos en metros.',
  noteTooFewPoints: 'Todavía hay muy pocos puntos para medir este espacio.',
  noteStrayExcluded:
    'Retornos aislados fuera de la huella densa excluidos: {count}; las dimensiones describen '
    + 'el espacio escaneado, igual que la hoja del plano.',
  noteDensityScaled:
    'La densidad y la separación se escalan de un subconjunto medido de {measured} puntos a la muestra '
    + 'cargada de {loaded} puntos (suponiendo un submuestreo de paso uniforme, uno de cada n puntos). La muestra cargada es lo que tiene '
    + 'el visor, y puede ser a su vez un subconjunto del archivo.',
  noteCeilingApproximate: 'Los techos suelen capturarse con pocos puntos: la altura de piso a techo y el volumen encerrado son aproximados.',
  noteCeilingMissing: 'Aún no se ha capturado un techo bien definido: la altura y el volumen no estarán disponibles hasta escanear la superficie superior.',
  noteWallsEstimate: 'Las cifras de muros y superficies planas son estimaciones prácticas, no un levantamiento certificado.',
  noteOpenObject: 'Objeto abierto: el volumen encerrado es una envolvente de caja, no una medición de un sólido.',

  planTitle: 'Vista previa del plano (muros trazados a partir del escaneo)',
  notesTitle: 'Notas',
  provenanceTitle: 'Procedencia',
  continued: ' (continúa)',
  roomImperial: 'Cuarto {i} {area} ft2',
  roomMetric: 'Cuarto {i} {area} m2',
  planDimsImperial: 'An {w} ft ({wAlt} m) x Fo {d} ft ({dAlt} m)',
  planDimsMetric: 'An {w} m ({wAlt} ft) x Fo {d} m ({dAlt} ft)',
  planCaptionGraph:
    'Vista previa experimental: reconstrucción del grafo de muros a partir del escaneo, no un plano medido; requiere validación visual.',
  planCaptionTrace:
    'Vista previa experimental: muros trazados a partir del escaneo, no un plano medido; requiere validación visual.',
};

const PT: Catalog = {
  scanInterior: 'Espaço interno',
  scanObject: 'Objeto',
  untitled: 'Varredura sem título',
  unknown: 'desconhecido',

  secDimensions: 'Dimensões',
  secPlanes: 'Planos',
  secCapture: 'Qualidade da captura',
  secMeasurements: 'Medições',

  lxwxh: 'C x L x A',
  footprint: 'Área ocupada em planta',
  ceilingHeight: 'Pé-direito',
  enclosedVolume: 'Volume fechado',
  storeys: 'Pavimentos / níveis',
  floor: 'Piso',
  ceiling: 'Teto',
  walls: 'Paredes',
  oriented: 'Orientada (C x L x A)',
  axisAligned: 'Alinhada aos eixos (C x L x A)',
  largest: 'Maior dimensão (não validada)',
  envelopeVolume: 'Volume do envelope',
  boundingSurface: 'Área da superfície envolvente',
  angularCoverage: 'Cobertura angular',
  points: 'Pontos (medidos / carregados)',
  density: 'Densidade',
  spacing: 'Espaçamento médio',
  boundingFilled: 'Área ocupada do retângulo envolvente',
  colour: 'Cor (RGB)',
  status: 'Situação',

  present: 'Presente  {area}',
  notDetected: 'Não detectado',
  wallsValue: '{pct}% de cobertura / ~{n} direção(ões)',
  pointsValue: '{measured} medidos / {loaded} carregados',
  yes: 'Sim',
  no: 'Não',
  angularValue: '{pct}% das direções em torno do centroide',
  noMeasurements: 'Ainda não há medições disponíveis.',
  percent: '{pct}%',

  hintLargest:
    'Lado mais longo da caixa orientada, o valor principal de tamanho. A caixa é ajustada pelos '
    + 'eixos principais, que tendem à diagonal em conjuntos de pontos planos ou simétricos; trate-o '
    + 'como uma estimativa não validada, e não como uma extensão medida.',
  hintEnvelopeVolume: 'Envelope: não é um volume sólido. Uma nuvem de pontos não tem interior fechado.',
  hintBoundingSurface:
    'Área da superfície da caixa envolvente (aproximada): a pele do envelope, não a superfície '
    + 'real (malha) do objeto.',
  hintAngular:
    'Parcela dos intervalos de direção em torno do centroide do conjunto de pontos que têm retornos. Acompanha a '
    + 'forma da varredura: uma superfície plana ou laminar preenche só parte da esfera, por mais '
    + 'completa que seja a captura.',

  sourceUnits: '(unidades de origem)',
  sourceUnitsSq: '(unidades de origem ao quadrado)',
  sourceUnitsCu: '(unidades de origem ao cubo)',
  densityMetric: '{v} pts/m²',
  densitySource: '{v} pts por unidade de origem ao quadrado',

  unitsUnknown: 'unidades de origem (escala não verificada, não se afirma que sejam metros)',
  unitsMetres: 'metros',
  unitsFeet: 'pés (origem) → metros',
  unitsFactor: 'unidades de origem × {f} → metros',

  kSoftware: 'Software',
  kMetricVersion: 'Versão das métricas',
  kGenerated: 'Gerado em',
  kSource: 'Origem',
  kScanType: 'Tipo de varredura',
  kUnits: 'Unidades',
  kPoints: 'Pontos',
  kCoverage: 'Cobertura',
  kNote: 'Nota',
  kEvidence: 'Evidência',
  kLanguage: 'Idioma',
  pointsLine: '{measured} medidos / {loaded} carregados no visualizador',
  coverageLine: '{coverage}. Os valores vêm dos pontos lidos.',
  languageDraft: '{name} (tradução ainda não revisada)',

  notSurveyGrade: 'Adequação: sem qualidade de levantamento topográfico, salvo validação com pontos de controle em campo.',
  evidence:
    'Estimativa de envelope não validada. As áreas, os volumes, a cobertura angular e a densidade '
    + 'deste relatório são estimativas de envelope e de grade a partir da amostra de pontos carregada. Nenhuma '
    + 'afirmação registrada as cobre, portanto não têm validação cruzada entre implementações nem '
    + 'validação em campo. Não apresente este documento como um entregável validado.',

  noteStream: 'Com base nos pontos carregados no visualizador.',
  noteStreamPartial:
    'Preliminar: até agora só foi medida a parte da varredura já transmitida; dimensões, áreas e '
    + 'volumes vão mudar à medida que mais dados carregarem. Deixe a nuvem completa ser transmitida e calcule de novo.',
  noteUnitUnverified:
    'As unidades das coordenadas não foram verificadas, então dimensões, áreas, volumes e densidades '
    + 'são dados nas unidades do próprio arquivo, não em metros. Confirme o SRC de '
    + 'origem para expressá-los em metros.',
  noteTooFewPoints: 'Ainda não há pontos suficientes para medir este espaço.',
  noteStrayExcluded:
    'Retornos isolados fora da área densa em planta excluídos: {count}; as dimensões descrevem o '
    + 'espaço escaneado, como na folha da planta.',
  noteDensityScaled:
    'A densidade e o espaçamento são escalados de um subconjunto medido de {measured} pontos para a '
    + 'amostra carregada de {loaded} pontos (supondo subamostragem de passo uniforme, um a cada n pontos). A amostra carregada é o que '
    + 'o visualizador tem, e pode ela mesma ser um subconjunto do arquivo.',
  noteCeilingApproximate: 'Tetos costumam ser capturados com poucos pontos: o pé-direito e o volume fechado são aproximados.',
  noteCeilingMissing: 'Ainda não há um teto bem definido capturado: altura e volume ficam indisponíveis até a superfície superior ser escaneada.',
  noteWallsEstimate: 'Os valores de paredes e planos são estimativas práticas, não um levantamento certificado.',
  noteOpenObject: 'Objeto aberto: o volume fechado é um envelope de caixa, não a medição de um sólido.',

  planTitle: 'Prévia da planta (paredes traçadas a partir da varredura)',
  notesTitle: 'Notas',
  provenanceTitle: 'Proveniência',
  continued: ' (continua)',
  roomImperial: 'Ambiente {i} {area} ft2',
  roomMetric: 'Ambiente {i} {area} m2',
  planDimsImperial: 'L {w} ft ({wAlt} m) x P {d} ft ({dAlt} m)',
  planDimsMetric: 'L {w} m ({wAlt} ft) x P {d} m ({dAlt} ft)',
  planCaptionGraph:
    'Prévia experimental: reconstrução do grafo de paredes a partir da varredura, não uma planta medida; requer validação visual.',
  planCaptionTrace:
    'Prévia experimental: paredes traçadas a partir da varredura, não uma planta medida; requer validação visual.',
};

const FR: Catalog = {
  scanInterior: 'Espace intérieur',
  scanObject: 'Objet',
  untitled: 'Scan sans titre',
  unknown: 'inconnue',

  secDimensions: 'Dimensions',
  secPlanes: 'Surfaces planes',
  secCapture: 'Qualité de capture',
  secMeasurements: 'Mesures',

  lxwxh: 'L x l x H',
  footprint: "Surface d'emprise",
  ceilingHeight: 'Hauteur sous plafond',
  enclosedVolume: 'Volume englobé',
  storeys: 'Niveaux',
  floor: 'Sol',
  ceiling: 'Plafond',
  walls: 'Murs',
  oriented: 'Orientée (L x l x H)',
  axisAligned: 'Alignée sur les axes (L x l x H)',
  largest: 'Plus grande dimension (non validée)',
  envelopeVolume: "Volume de l'enveloppe",
  boundingSurface: "Surface de l'enveloppe",
  angularCoverage: 'Couverture angulaire',
  points: 'Points (mesurés / chargés)',
  density: 'Densité',
  spacing: 'Espacement moyen',
  boundingFilled: 'Remplissage du rectangle englobant',
  colour: 'Couleur (RVB)',
  status: 'État',

  present: 'Présent  {area}',
  notDetected: 'Non détecté',
  wallsValue: '{pct} % de couverture / ~{n} direction(s)',
  pointsValue: '{measured} mesurés / {loaded} chargés',
  yes: 'Oui',
  no: 'Non',
  angularValue: '{pct} % des directions autour du centroïde',
  noMeasurements: 'Aucune mesure disponible pour le moment.',
  percent: '{pct} %',

  hintLargest:
    "Plus long côté de la boîte orientée, la principale valeur de taille. La boîte est ajustée sur les "
    + "axes principaux, qui dérivent vers la diagonale pour des nuages plats ou symétriques : à traiter "
    + "comme une estimation non validée, et non comme une étendue mesurée.",
  hintEnvelopeVolume: "Enveloppe : ce n'est pas un volume plein. Un nuage de points n'a pas d'intérieur étanche.",
  hintBoundingSurface:
    "Surface de la boîte englobante (approximative) : la peau de l'enveloppe, pas la surface réelle "
    + "(maillage) de l'objet.",
  hintAngular:
    "Part des directions autour du centroïde du nuage qui reçoivent des retours. Elle suit la forme du "
    + "scan : une surface plane ou en feuille ne remplit qu'une partie de la sphère, aussi complète "
    + "que soit la capture.",

  sourceUnits: '(unités source)',
  sourceUnitsSq: '(unités source carrées)',
  sourceUnitsCu: '(unités source cubes)',
  densityMetric: '{v} pts/m²',
  densitySource: '{v} pts par unité source carrée',

  unitsUnknown: 'unités source (échelle non vérifiée, non affirmée en mètres)',
  unitsMetres: 'mètres',
  unitsFeet: 'pieds (source) → mètres',
  unitsFactor: 'unités source × {f} → mètres',

  kSoftware: 'Logiciel',
  kMetricVersion: 'Version des métriques',
  kGenerated: 'Généré le',
  kSource: 'Source',
  kScanType: 'Type de scan',
  kUnits: 'Unités',
  kPoints: 'Points',
  kCoverage: 'Couverture',
  kNote: 'Note',
  kEvidence: "Éléments d'appui",
  kLanguage: 'Langue',
  pointsLine: '{measured} mesurés / {loaded} chargés dans la visionneuse',
  coverageLine: '{coverage}. Les valeurs proviennent des points lus.',
  languageDraft: '{name} (traduction pas encore relue)',

  notSurveyGrade: "Usage : pas de qualité topographique sans validation par des points de contrôle terrain.",
  evidence:
    "Estimation d'enveloppe non validée. Les surfaces, les volumes, la couverture angulaire et la densité "
    + "sont des estimations d'enveloppe et de grille à partir de l'échantillon de points chargé. Aucune "
    + "affirmation enregistrée ne les couvre : elles n'ont ni validation croisée entre "
    + "implémentations ni validation terrain. Ne présentez pas ce document comme un livrable validé.",

  noteStream: 'Calculé sur les points chargés dans la visionneuse.',
  noteStreamPartial:
    "Provisoire : seule la partie déjà diffusée du scan a été mesurée ; dimensions, surfaces "
    + "et volumes changeront à mesure du chargement. Laissez le nuage complet se charger, puis relancez.",
  noteUnitUnverified:
    "Les unités des coordonnées ne sont pas vérifiées : dimensions, surfaces, volumes et densités "
    + "sont donnés dans les unités du fichier, pas en mètres. Confirmez le SRC source "
    + "pour les exprimer en mètres.",
  noteTooFewPoints: "Trop peu de points pour mesurer cet espace pour l'instant.",
  noteStrayExcluded:
    "Retours isolés hors de l'emprise dense exclus : {count} ; les dimensions décrivent "
    + "l'espace scanné, comme la feuille du plan.",
  noteDensityScaled:
    "La densité et l'espacement sont extrapolés d'un sous-ensemble mesuré de {measured} points à "
    + "l'échantillon chargé de {loaded} points (hypothèse d'un pas régulier). L'échantillon chargé est "
    + "ce que contient la visionneuse, et peut lui-même n'être qu'une partie du fichier.",
  noteCeilingApproximate: 'Les plafonds sont souvent peu captés : la hauteur sous plafond et le volume englobé sont approximatifs.',
  noteCeilingMissing: "Aucun plafond net n'est encore capté : hauteur et volume restent indisponibles tant que la surface supérieure n'est pas scannée.",
  noteWallsEstimate: 'Les valeurs des murs et des surfaces planes sont des estimations pratiques, pas un levé certifié.',
  noteOpenObject: "Objet ouvert : le volume englobé est une enveloppe de boîte, pas la mesure d'un solide.",

  planTitle: 'Aperçu du plan (murs tracés à partir du scan)',
  notesTitle: 'Notes',
  provenanceTitle: 'Provenance',
  continued: ' (suite)',
  roomImperial: 'Pièce {i} {area} ft2',
  roomMetric: 'Pièce {i} {area} m2',
  planDimsImperial: 'l {w} ft ({wAlt} m) x P {d} ft ({dAlt} m)',
  planDimsMetric: 'l {w} m ({wAlt} ft) x P {d} m ({dAlt} ft)',
  planCaptionGraph:
    "Aperçu expérimental : reconstruction du graphe des murs à partir du scan, pas un plan mesuré ; à valider visuellement.",
  planCaptionTrace:
    "Aperçu expérimental : murs tracés à partir du scan, pas un plan mesuré ; à valider visuellement.",
};

const DE: Catalog = {
  scanInterior: 'Innenraum',
  scanObject: 'Objekt',
  untitled: 'Unbenannter Scan',
  unknown: 'unbekannt',

  secDimensions: 'Abmessungen',
  secPlanes: 'Ebene Flächen',
  secCapture: 'Erfassungsqualität',
  secMeasurements: 'Messungen',

  lxwxh: 'L x B x H',
  footprint: 'Belegte Grundfläche',
  ceilingHeight: 'Raumhöhe',
  enclosedVolume: 'Umschlossenes Volumen',
  storeys: 'Geschosse / Ebenen',
  floor: 'Boden',
  ceiling: 'Decke',
  walls: 'Wände',
  oriented: 'Orientiert (L x B x H)',
  axisAligned: 'Achsparallel (L x B x H)',
  largest: 'Größte Abmessung (nicht validiert)',
  envelopeVolume: 'Hüllvolumen',
  boundingSurface: 'Hüllflächeninhalt',
  angularCoverage: 'Winkelabdeckung',
  points: 'Punkte (gemessen / geladen)',
  density: 'Dichte',
  spacing: 'Mittlerer Punktabstand',
  boundingFilled: 'Gefüllter Anteil des Hüllrechtecks',
  colour: 'Farbe (RGB)',
  status: 'Status',

  present: 'Vorhanden  {area}',
  notDetected: 'Nicht erkannt',
  wallsValue: '{pct} % Abdeckung / ~{n} Richtung(en)',
  pointsValue: '{measured} gemessen / {loaded} geladen',
  yes: 'Ja',
  no: 'Nein',
  angularValue: '{pct} % der Richtungen um den Schwerpunkt',
  noMeasurements: 'Noch keine Messungen verfügbar.',
  percent: '{pct} %',

  hintLargest:
    'Längste Seite des orientierten Quaders, die maßgebliche Größenangabe. Der Quader wird über die '
    + 'Hauptachsen angepasst, die bei flachen oder symmetrischen Punktmengen zur Diagonale driften; '
    + 'als nicht validierte Schätzung behandeln, nicht als gemessene Ausdehnung.',
  hintEnvelopeVolume: 'Hülle: kein Festkörpervolumen. Eine Punktwolke hat kein dichtes Inneres.',
  hintBoundingSurface:
    'Oberfläche des Hüllquaders (näherungsweise): die Haut der Hülle, nicht die tatsächliche '
    + '(Netz-)Oberfläche des Objekts.',
  hintAngular:
    'Anteil der Richtungen um den Schwerpunkt der Punktmenge, aus denen Echos vorliegen. Er folgt '
    + 'der Form des Scans: Eine flache oder blattartige Fläche füllt nur einen Teil der Kugel, wie '
    + 'vollständig sie auch erfasst wurde.',

  sourceUnits: '(Quelleinheiten)',
  sourceUnitsSq: '(Quelleinheiten im Quadrat)',
  sourceUnitsCu: '(Quelleinheiten hoch drei)',
  densityMetric: '{v} Pkt./m²',
  densitySource: '{v} Pkt. pro Quelleinheit im Quadrat',

  unitsUnknown: 'Quelleinheiten (Maßstab nicht geprüft, nicht als Meter angegeben)',
  unitsMetres: 'Meter',
  unitsFeet: 'Fuß (Quelle) → Meter',
  unitsFactor: 'Quelleinheiten × {f} → Meter',

  kSoftware: 'Software',
  kMetricVersion: 'Metrikversion',
  kGenerated: 'Erstellt',
  kSource: 'Quelle',
  kScanType: 'Scantyp',
  kUnits: 'Einheiten',
  kPoints: 'Punkte',
  kCoverage: 'Abdeckung',
  kNote: 'Hinweis',
  kEvidence: 'Evidenz',
  kLanguage: 'Sprache',
  pointsLine: '{measured} gemessen / {loaded} im Viewer geladen',
  coverageLine: '{coverage}. Die Werte stammen aus den gelesenen Punkten.',
  languageDraft: '{name} (Übersetzung noch nicht geprüft)',

  notSurveyGrade: 'Eignung: nicht vermessungstauglich, sofern nicht anhand von Kontrollpunkten im Feld validiert.',
  evidence:
    'Nicht validierte Hüllschätzung. Flächen, Volumen, Winkelabdeckung und Dichte sind Hüll- und '
    + 'Rasterschätzungen aus der geladenen Punktstichprobe. Keine registrierte Aussage deckt sie ab, '
    + 'daher haben sie weder eine Kreuzvalidierung zwischen Implementierungen noch eine '
    + 'Feldvalidierung. Dieses Dokument nicht als validiertes Lieferergebnis darstellen.',

  noteStream: 'Beruht auf den im Viewer geladenen Punkten.',
  noteStreamPartial:
    'Vorläufig: Bisher ist nur der bereits gestreamte Teil des Scans gemessen; Abmessungen, Flächen und '
    + 'Volumen ändern sich, wenn mehr geladen wird. Die ganze Wolke laden lassen und dann neu berechnen.',
  noteUnitUnverified:
    'Die Koordinateneinheiten sind nicht geprüft, daher sind Abmessungen, Flächen, Volumen und Dichten '
    + 'in den eigenen Einheiten der Datei angegeben, nicht in Metern. Das Quell-KBS bestätigen, '
    + 'um sie in Metern anzugeben.',
  noteTooFewPoints: 'Noch zu wenige Punkte, um diesen Raum zu messen.',
  noteStrayExcluded:
    'Ausgeschlossene vereinzelte Echos außerhalb der dichten Grundfläche: {count}; die '
    + 'Abmessungen beschreiben den gescannten Raum, wie das Grundrissblatt.',
  noteDensityScaled:
    'Dichte und Punktabstand werden von einer gemessenen Teilmenge mit {measured} Punkten auf die '
    + 'geladene Stichprobe mit {loaded} Punkten hochgerechnet (Annahme gleichmäßiger Ausdünnung). Die '
    + 'geladene Stichprobe ist das, was der Viewer hält, und kann selbst eine Teilmenge der Datei sein.',
  noteCeilingApproximate: 'Decken werden oft nur spärlich erfasst: Raumhöhe und umschlossenes Volumen sind Näherungswerte.',
  noteCeilingMissing: 'Noch keine klare Decke erfasst: Höhe und Volumen sind erst verfügbar, wenn die obere Fläche gescannt ist.',
  noteWallsEstimate: 'Werte für Wände und ebene Flächen sind pragmatische Schätzungen, keine zertifizierte Vermessung.',
  noteOpenObject: 'Offenes Objekt: Das umschlossene Volumen ist eine Quaderhülle, keine Festkörpermessung.',

  planTitle: 'Grundrissvorschau (Wände aus dem Scan nachgezeichnet)',
  notesTitle: 'Hinweise',
  provenanceTitle: 'Herkunft',
  continued: ' (Fortsetzung)',
  roomImperial: 'Raum {i} {area} ft2',
  roomMetric: 'Raum {i} {area} m2',
  planDimsImperial: 'B {w} ft ({wAlt} m) x T {d} ft ({dAlt} m)',
  planDimsMetric: 'B {w} m ({wAlt} ft) x T {d} m ({dAlt} ft)',
  planCaptionGraph:
    'Experimentelle Vorschau: Rekonstruktion des Wandgraphen aus dem Scan, kein gemessener Grundriss; visuelle Prüfung erforderlich.',
  planCaptionTrace:
    'Experimentelle Vorschau: Wände aus dem Scan nachgezeichnet, kein gemessener Grundriss; visuelle Prüfung erforderlich.',
};

export const SPACE_REPORT_TEXT: Readonly<Record<ExportLanguage, Catalog>> = { en: EN, es: ES, pt: PT, fr: FR, de: DE };
