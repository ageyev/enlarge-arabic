// see:
// https://betterprogramming.pub/creating-chrome-extensions-with-typescript-914873467b65

// https://webpack.js.org/plugins/copy-webpack-plugin/
const CopyPlugin = require("copy-webpack-plugin");

// https://github.com/webpack/css-minimizer-webpack-plugin
// https://webpack.js.org/plugins/css-minimizer-webpack-plugin/
const CssMinimizerPlugin = require("css-minimizer-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

//
const path = require('path');

module.exports = {

    mode: "production", // https://webpack.js.org/configuration/mode/ // TODO: change to 'production' in production
    // mode: "development", // https://webpack.js.org/configuration/mode/
    // https://webpack.js.org/configuration/devtool/
    // (none) - Recommended choice for production builds with maximum performance
    // devtool: 'source-map', // Recommended choice for production builds with high quality SourceMaps
    // devtool: 'cheap-module-source-map',
    // devtool: 'eval-source-map', // Recommended choice for development builds with high quality SourceMaps << Error
    entry: {
        background: path.resolve(__dirname, "..", "src", "background/background.ts"),
        content: path.resolve(__dirname, "..", "src", "content/content.ts"),
        // sidepanel: path.resolve(__dirname, "..", "src", "sidepanel/sidepanel.tsx"),
        // options: path.resolve(__dirname, "..", "src", "options/options.tsx"),
        // css: path.resolve(__dirname, "..", "src", "content/css.css")
    },
    output: {
        // Clean the output directory before emit
        // https://webpack.js.org/configuration/output/#outputclean
        clean: true,
        path: path.resolve(__dirname, '../dist'),
        // filename: 'bundle.js',
        filename: "[name].js",
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [
            {
                // Include all modules that pass test assertion
                // https://webpack.js.org/configuration/module/#ruletest
                // we set a regular expression in test of what file endings to run the ts-loader on
                test: /\.tsx?$/,
                use: {
                    loader: 'ts-loader',
                },
                // in exclude we are telling webpack not to traverse through the node_modules dependencies
                exclude: /node_modules/,
            },
            {
                test: /\.s?css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    "css-loader",
                ],
            },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                // { from: "source", to: "dest" },
                {from: "public", to: "../dist"},
            ],
        }),
        // This plugin extracts CSS into separate files
        new MiniCssExtractPlugin({
            filename: '[name].css',
        }),
    ],
    // Optimization settings for production
    optimization: {
        minimize: true,
        minimizer: [
            // For webpack 5+, use the '...' syntax to extend existing minimizers
            // (like the default TerserPlugin for JS).
            '...',
            // Use CssMinimizerPlugin for CSS optimization
            new CssMinimizerPlugin(),
        ],
    },
};
