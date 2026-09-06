import { Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { DevPage } from './pages/DevPage'
import { PreviewPage } from './pages/PreviewPage'
import { ProductionPage } from './pages/ProductionPage'

export function AppRouter() {
    return (
        <Routes>
            <Route path='/' element={<HomePage />} />
            <Route path='/dev' element={<DevPage />} />
            <Route path='/preview' element={<PreviewPage />} />
            <Route path='/production' element={<ProductionPage />} />
            <Route
                path='/deployment'
                element={
                    <>
                        <ProductionPage></ProductionPage>
                    </>
                }
            />
            <Route path='*' element={<HomePage />} />
        </Routes>
    )
}
