// The Ink mark (official brand kit, docs.inkonchain.com/work-with-ink/brand-kit), as a tiny
// badge on the Specimen tab: Ink points go to people who feed. Unchanged shape; the inner
// wave is cut out of the disc so the panel glass shows through. Colors: Ink Light #9E70FF.
// It glows and breathes gently while you are feeding this specimen (you hold part of it);
// otherwise it rests dim. No amounts are stated anywhere.
import { t } from './reveal'

const OUTER = 'M90.4486 0C140.402 -2.18353e-06 180.897 40.4952 180.897 90.4486C180.897 140.402 140.402 180.897 90.4486 180.897C40.4952 180.897 2.18353e-06 140.402 0 90.4486C-2.18353e-06 40.4952 40.4952 2.18353e-06 90.4486 0Z'
const INNER = 'M91.1735 169.409C98.3217 169.266 103.358 164.278 103.358 158.142C103.358 151.916 98.4517 147.302 92.1713 147.302C89.0105 147.302 87.5766 147.302 86.1452 147.243C84.7325 147.184 83.3221 147.067 80.2561 146.835C74.0838 146.368 68.8693 141.81 68.8693 135.565C68.8693 129.339 73.957 124.295 80.2561 124.295H91.9897C98.2702 124.295 103.358 119.252 103.358 113.025C103.358 106.781 98.2702 101.737 91.9897 101.737H53.4334C47.1343 101.737 42.0466 96.6933 42.0466 90.4671C42.0466 84.2225 47.1343 79.1603 53.4334 79.1603L129.904 79.1603C136.184 79.1603 141.272 74.1166 141.272 67.8904C141.272 61.6643 136.184 56.6206 129.904 56.6206H80.2561C73.957 56.6206 68.8693 51.5768 68.8693 45.3137C68.8693 39.0876 74.6581 34.4925 80.2561 34.0439C85.8542 33.5953 86.1414 33.5953 91.9895 33.5953C97.8379 33.5953 103.358 29.0001 103.358 22.7555C103.358 16.6199 99.2199 11.6325 91.1531 11.4888C90.9185 11.4867 90.6836 11.4857 90.4484 11.4857C46.8383 11.4857 11.4854 46.8387 11.4854 90.4488C11.4854 134.015 46.7679 169.341 90.3181 169.412H90.5787C90.7771 169.411 90.9754 169.41 91.1735 169.409Z'

export function InkMark({ active, size = 16 }: { active: boolean; size?: number }) {
  const label = t('ink.points')
  return (
    <span className={active ? 'ink-mark on' : 'ink-mark'} title={label} aria-label={label} role="img">
      <svg width={size} height={size} viewBox="0 0 181 181" aria-hidden="true">
        <defs>
          <mask id="ink-cut">
            <path d={OUTER} fill="white" />
            <path d={INNER} fill="black" />
          </mask>
        </defs>
        <path d={OUTER} fill="currentColor" mask="url(#ink-cut)" />
      </svg>
    </span>
  )
}
