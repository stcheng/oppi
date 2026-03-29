import Testing
import UIKit
@testable import Oppi

@Suite("RenderTheme mapping")
struct RenderThemeMappingTests {
    @Test func paletteRenderThemeMapsCoreTokens() {
        let palette = ThemePalettes.light
        let renderTheme = palette.renderTheme

        assertEqual(renderTheme.foreground, UIColor(palette.fg))
        assertEqual(renderTheme.foregroundDim, UIColor(palette.fgDim))
        assertEqual(renderTheme.background, UIColor(palette.bg))
        assertEqual(renderTheme.backgroundDark, UIColor(palette.bgDark))
        assertEqual(renderTheme.comment, UIColor(palette.comment))
    }

    @Test func paletteRenderThemeMapsSyntaxAndAccentTokens() {
        let palette = ThemePalettes.light
        let renderTheme = palette.renderTheme

        assertEqual(renderTheme.keyword, UIColor(palette.syntaxKeyword))
        assertEqual(renderTheme.string, UIColor(palette.syntaxString))
        assertEqual(renderTheme.number, UIColor(palette.syntaxNumber))
        assertEqual(renderTheme.function, UIColor(palette.syntaxFunction))
        assertEqual(renderTheme.type, UIColor(palette.syntaxType))
        assertEqual(renderTheme.link, UIColor(palette.mdLink))
        assertEqual(renderTheme.heading, UIColor(palette.mdHeading))
        assertEqual(renderTheme.accentBlue, UIColor(palette.blue))
        assertEqual(renderTheme.accentGreen, UIColor(palette.green))
        assertEqual(renderTheme.accentOrange, UIColor(palette.orange))
        assertEqual(renderTheme.accentPurple, UIColor(palette.purple))
        assertEqual(renderTheme.accentRed, UIColor(palette.red))
        assertEqual(renderTheme.accentYellow, UIColor(palette.yellow))
    }

    @Test func currentRenderThemeTracksRuntimeTheme() {
        let original = ThemeRuntimeState.currentThemeID()
        defer { ThemeRuntimeState.setThemeID(original) }

        ThemeRuntimeState.setThemeID(.light)
        assertEqual(ThemeRuntimeState.currentRenderTheme().foreground, UIColor(ThemePalettes.light.fg))
        assertEqual(ThemeRuntimeState.currentRenderTheme().accentRed, UIColor(ThemePalettes.light.red))

        ThemeRuntimeState.setThemeID(.night)
        assertEqual(ThemeRuntimeState.currentRenderTheme().foreground, UIColor(ThemePalettes.night.fg))
        assertEqual(ThemeRuntimeState.currentRenderTheme().accentBlue, UIColor(ThemePalettes.night.blue))
    }

    private func assertEqual(_ lhs: CGColor, _ rhs: UIColor) {
        let left = UIColor(cgColor: lhs)
        var lr: CGFloat = 0
        var lg: CGFloat = 0
        var lb: CGFloat = 0
        var la: CGFloat = 0
        var rr: CGFloat = 0
        var rg: CGFloat = 0
        var rb: CGFloat = 0
        var ra: CGFloat = 0
        #expect(left.getRed(&lr, green: &lg, blue: &lb, alpha: &la))
        #expect(rhs.getRed(&rr, green: &rg, blue: &rb, alpha: &ra))
        #expect(abs(lr - rr) < 0.001)
        #expect(abs(lg - rg) < 0.001)
        #expect(abs(lb - rb) < 0.001)
        #expect(abs(la - ra) < 0.001)
    }
}
