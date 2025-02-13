import Papa from "papaparse";
import { GeneVariant } from "./GeneVariant";
import type { MpsData } from "./MpsData";
import { Genotype } from "./Genotype";

export type GeneDataRowParser = (data: string[][], mpsData: MpsData) => GeneVariant[];

/**
 * An abstraction over the parsing and handling of genetic data.
 */
export class GeneDataParser {
  file: File;
  parseRow: GeneDataRowParser;
  delimiter: string;
  mpsData: MpsData;

  constructor(file: File, parseRow: GeneDataRowParser, delimiter: string, mpsData: MpsData) {
    this.file = file;
    this.parseRow = parseRow;
    this.delimiter = delimiter;
    this.mpsData = mpsData
  }

  /**
   * Decides which parser to use based on the different formats {@link file} can have.
   * Therefore, this is probably what you want to use to construct a {@link GeneDataParser}, 
   * rather than the constructor.
   * @param file The gene data file. Usually a CSV
   * @param mpsData The MPS Data file. Usually a JSON. Should be statically served under ./mps
   * @returns A new {@link GeneDataParser}
   */
  static async fromFile(file: File, mpsData: MpsData): Promise<GeneDataParser> {
    const maxSize = 1024 * 1024 * 100 // 100 Mb
    const fileExtension = file.name.split('.').at(-1);

    return new Promise((resolve, reject) => {
      if (file.size > maxSize) {
        console.debug('Streaming large file=' + file.name)
        if (fileExtension !== 'vcf') {
          // TODO: Error message
          throw Error("Large file is not a vcf file")
        }
        resolve(new GeneDataParser(file, GeneDataParser.parseVCFData, '\t', mpsData));
      } else {
        Papa.parse(file, {
          preview: 1,
          complete: (results) => {
            const firstLine: string = results.data.join('')
            const twentyThreeAndMeHeader = 'generated by 23andMe'
            const ancestryHeader = '#AncestryDNA raw data download'
            if (firstLine.includes(twentyThreeAndMeHeader)) {
              console.debug('detected 23andme data')
              resolve(new GeneDataParser(file, GeneDataParser.parse23AndMeData, '\t', mpsData));
            } else if (firstLine.includes(ancestryHeader)) {
              console.debug('detected ancestry data')
              resolve(new GeneDataParser(file, GeneDataParser.parseAncestryData, ',', mpsData));
            } else {
              // TODO: Error message
              reject(Error('Unable to determine the filetype from the header.'));
            }
          }
        })
      }
    })
  }

  /**
   * Given the {@link parseRow} that was set during construction, parses the {@link file}
   * to return an array of {@link GeneVariant}s.
   * @param onUpdateProgress A function that allows the call-site (i.e. likely a svelte component) 
   * to render a progress bar as the {@link file} is parsed.
   * @returns A Promise that returns an array of {@link GeneVariant}.
   */
  async parse(onUpdateProgress: (progress: number) => void): Promise<GeneVariant[]> {
    const chunkSize = 1024 * 50 // 50KB
    let matchingRsids: GeneVariant[] = [] // aggregate all SNPs

    // for updating the progress bar
    const fileSize = this.file.size
    let processedSize = 0

    return new Promise((resolve, reject) => {
      Papa.parse(this.file, {
        chunkSize,
        dynamicTyping: true,
        delimiter: this.delimiter,
        chunk: (results, parser) => {
          const data = results.data as string[][]
          processedSize += chunkSize

          const progress = processedSize / fileSize * 100
          onUpdateProgress(progress);
          // progressBarUpdate(elements, `${progress}%`)

          try {
            const foundSnps = this.parseRow(data, this.mpsData)
            matchingRsids = matchingRsids.concat(foundSnps)
          } catch (error) {
            // TODO: Error message
            console.error('Error while parsing chunk:', error)
            alert('An error occurred while parsing the file.')
            parser.abort()
          }
        },
        complete(results, file) {
          resolve(matchingRsids);
        },
        error(error, file) {
          reject(error);
        },
      })
    });
  }

  private static parse23AndMeData(data: string[][], mpsData: MpsData): GeneVariant[] {
    const foundSnps: GeneVariant[] = []
    data.forEach(row => {
      // console.log(`row=${row[0]}`)
      if (row.length < 4 || (typeof row[0] === 'string' && row[0].startsWith('#'))) {
        return // skip these rows
      }
      const snp = row[0]
      if (snp in mpsData) {
        const onForward = mpsData[snp].onForwardStrand ?? true;
        let genotype = Genotype.fromString(row[3]);
        if (!onForward) {
          genotype = genotype?.fromOppositeStrand() ?? null;
        }
        const foundSnp = new GeneVariant({
          gene: mpsData[snp].gene,
          rsid: snp,
          chromosome: row[1],
          position: row[2],
          genotype: genotype,
          phenotype: mpsData[snp].phenotype,
          pathogenic: mpsData[snp].pathogenic.map(Genotype.fromString).filter(item => item !== null),
        });
        foundSnps.push(foundSnp);
      }
    })
    return foundSnps
  }

  private static parseAncestryData(data: string[][], mpsData: MpsData): GeneVariant[] {
    const foundSnps: GeneVariant[] = []
    data.forEach(row => {
      row = row[0]?.split('\t') ?? [] // HACK: This is a workaround for Papa misreading AncestryDNA files.
      if (row.length < 4) {
        return // skip these rows
      }
      const snp = row[0]
      if (snp in mpsData) {
        const onForward = mpsData[snp].onForwardStrand ?? true;
        let genotype = Genotype.fromString(row[3] + row[4]);
        if (!onForward) {
          genotype = genotype?.fromOppositeStrand() ?? null;
        }
        const foundSnp = new GeneVariant({
          gene: mpsData[snp].gene,
          rsid: snp,
          chromosome: row[1],
          position: row[2],
          genotype: genotype,
          phenotype: mpsData[snp].phenotype,
          pathogenic: mpsData[snp].pathogenic.map(Genotype.fromString).filter(item => item !== null),
        });
        foundSnps.push(foundSnp);
      }
    })
    return foundSnps
  }

  private static parseVCFData(data: string[][], mpsData: MpsData): GeneVariant[] {
    const foundSnps: GeneVariant[] = []
    data.forEach(row => {
      if (row.length < 10 || (typeof row[0] === 'string' && row[0].startsWith('#'))) {
        return // skip these rows
      }
      const snp = row[2]
      if (snp in mpsData) {
        const ref = row[3]; // Reference allele
        const alt = row[4]; // Alternate allele(s)
        const genotype = GeneDataParser.parseVCFGenotype(row[9], ref, alt.split(','));
        foundSnps.push(new GeneVariant({
          gene: mpsData[snp].gene,
          rsid: snp,
          chromosome: row[0],
          position: row[1],
          genotype: genotype,
          phenotype: mpsData[snp].phenotype,
          pathogenic: mpsData[snp].pathogenic.map(Genotype.fromString).filter(item => item !== null),
        }))
      }
    })
    return foundSnps
  }

  private static parseVCFGenotype(genotypeField: string, ref: string, alts: string[]): Genotype | null {
    const [genotype] = genotypeField.split(':'); // Extract genotype from the field
    const alleles = genotype.split(/[|/]/); // Split by '|' or '/'
    const alleleString = alleles.map(allele => {
      const index = parseInt(allele, 10);
      return index === 0 ? ref : alts[index - 1] || '.';
    }).join('');
    return Genotype.fromString(alleleString);
  }
}

